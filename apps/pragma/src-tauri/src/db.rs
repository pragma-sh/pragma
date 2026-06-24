use std::path::Path;
use std::sync::Mutex;

use pragma_constants::{DiffSide, Project, Tab, TabKind, Worktree};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

pub struct Db(pub Mutex<Connection>);

/// A persisted per-worktree split-pane layout. `layout` is opaque JSON owned and
/// shaped entirely by the frontend; the backend stores and returns it verbatim.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitLayout {
    pub worktree_id: String,
    pub layout: String,
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        let db = Self(Mutex::new(conn));
        db.migrate()?;
        Ok(db)
    }

    #[cfg(test)]
    pub fn in_memory() -> AppResult<Self> {
        let db = Self(Mutex::new(Connection::open_in_memory()?));
        db.migrate()?;
        Ok(db)
    }

    // The schema and every versioned migration live inline here, in order, so
    // the full history reads top-to-bottom in one place; that intentionally
    // pushes it past clippy's per-function line budget.
    #[allow(clippy::too_many_lines)]
    fn migrate(&self) -> AppResult<()> {
        let conn = self.0.lock()?;
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS projects (
               id          TEXT PRIMARY KEY,
               name        TEXT NOT NULL,
               path        TEXT NOT NULL UNIQUE,
               order_index INTEGER NOT NULL,
               created_at  TEXT NOT NULL DEFAULT (datetime('now'))
             );
             CREATE TABLE IF NOT EXISTS worktrees (
               id         TEXT PRIMARY KEY,
               project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
               parent_id  TEXT REFERENCES worktrees(id) ON DELETE CASCADE,
               branch     TEXT NOT NULL,
               title      TEXT,
               path       TEXT NOT NULL UNIQUE,
               is_main    INTEGER NOT NULL DEFAULT 0,
               hidden     INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);
             CREATE TABLE IF NOT EXISTS settings (
               key   TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tabs (
               id           TEXT PRIMARY KEY,
               project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
               worktree_id  TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
               title        TEXT,
               file_path    TEXT,
               diff_side    TEXT,
               pr_number    INTEGER,
               user_renamed INTEGER NOT NULL DEFAULT 0,
               order_index  INTEGER NOT NULL,
               created_at   TEXT NOT NULL DEFAULT (datetime('now'))
             );
             CREATE INDEX IF NOT EXISTS idx_tabs_project ON tabs(project_id);
             CREATE TABLE IF NOT EXISTS splits (
               worktree_id TEXT PRIMARY KEY REFERENCES worktrees(id) ON DELETE CASCADE,
               layout      TEXT NOT NULL,
               updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
             );",
        )?;

        // Versioned migrations. v2 adds browser-tab columns to `tabs`. Running the
        // ALTERs only when `user_version < 2` keeps them out of the idempotent
        // CREATE block above, so fresh and upgraded DBs converge on one schema.
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version < 2 {
            conn.execute_batch(
                "ALTER TABLE tabs ADD COLUMN kind TEXT NOT NULL DEFAULT 'terminal';
                 ALTER TABLE tabs ADD COLUMN url TEXT;
                 PRAGMA user_version = 2;",
            )?;
        }
        // v3 adds the `hidden` flag to `worktrees` so users can collapse rows
        // they don't actively use without losing the worktree itself. Default
        // 0 keeps existing rows visible. The CREATE block above already
        // includes the column for fresh DBs, so the ALTER is gated on
        // whether it's actually missing.
        if version < 3 {
            let has_hidden: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('worktrees') WHERE name = 'hidden'",
                    [],
                    |row| row.get(0),
                )
                .map_err(AppError::from)?;
            if has_hidden == 0 {
                conn.execute_batch(
                    "ALTER TABLE worktrees ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;",
                )?;
            }
            conn.execute_batch("PRAGMA user_version = 3;")?;
        }
        // v4 adds the `splits` table, which persists the per-worktree split-pane
        // layout as an opaque JSON blob (the shape is owned by the frontend). The
        // CREATE block above already provisions it for fresh DBs; the version bump
        // keeps upgraded DBs marked consistently.
        if version < 4 {
            conn.execute_batch("PRAGMA user_version = 4;")?;
        }
        // v5 adds `file_path` + `diff_side` to `tabs` so editor/diff tabs persist
        // and restore. The CREATE block above already provisions them for fresh
        // DBs; the ALTERs are gated on whether the columns are actually missing.
        if version < 5 {
            let has_file_path: i64 = conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tabs') WHERE name = 'file_path'",
                [],
                |row| row.get(0),
            )?;
            if has_file_path == 0 {
                conn.execute_batch(
                    "ALTER TABLE tabs ADD COLUMN file_path TEXT;
                     ALTER TABLE tabs ADD COLUMN diff_side TEXT;",
                )?;
            }
            conn.execute_batch("PRAGMA user_version = 5;")?;
        }
        // v6 adds `user_renamed` to `tabs` so terminal tabs can remember whether
        // the user has manually renamed them, and refuse to be clobbered by
        // shell-emitted OSC 0/2 title updates on the next launch. Default 0
        // (not renamed) preserves the previous behavior for every existing row —
        // shells can immediately take over tab titles again.
        if version < 6 {
            let has_user_renamed: i64 = conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tabs') WHERE name = 'user_renamed'",
                [],
                |row| row.get(0),
            )?;
            if has_user_renamed == 0 {
                conn.execute_batch(
                    "ALTER TABLE tabs ADD COLUMN user_renamed INTEGER NOT NULL DEFAULT 0;",
                )?;
            }
            conn.execute_batch("PRAGMA user_version = 6;")?;
        }
        // v7 adds a nullable `pr_number` to `tabs` so pull-request review tabs
        // (`kind = 'pr-review'`) persist which PR they review. Default NULL leaves
        // every existing row untouched. The CREATE block above already provisions
        // the column for fresh DBs, so the ALTER is gated on whether it's missing.
        if version < 7 {
            let has_pr_number: i64 = conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tabs') WHERE name = 'pr_number'",
                [],
                |row| row.get(0),
            )?;
            if has_pr_number == 0 {
                conn.execute_batch("ALTER TABLE tabs ADD COLUMN pr_number INTEGER;")?;
            }
            conn.execute_batch("PRAGMA user_version = 7;")?;
        }
        Ok(())
    }

    pub fn list_projects(&self) -> AppResult<Vec<Project>> {
        let conn = self.0.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, path, order_index, created_at FROM projects ORDER BY order_index, created_at",
        )?;
        let rows = stmt.query_map([], project_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn insert_project_with_main_worktree(
        &self,
        name: String,
        path: String,
        branch: String,
    ) -> AppResult<Project> {
        let project_id = Uuid::new_v4().to_string();
        let worktree_id = Uuid::new_v4().to_string();
        {
            let mut conn = self.0.lock()?;
            // Atomic so a crash can't leave a project without its main worktree —
            // an invariant the rest of the app relies on.
            let tx = conn.transaction()?;
            let order_index: i64 =
                tx.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?;
            tx.execute(
                "INSERT INTO projects (id, name, path, order_index) VALUES (?1, ?2, ?3, ?4)",
                params![project_id, name, path, order_index],
            )?;
            tx.execute(
                "INSERT INTO worktrees (id, project_id, parent_id, branch, title, path, is_main)
                 VALUES (?1, ?2, NULL, ?3, NULL, ?4, 1)",
                params![worktree_id, project_id, branch, path],
            )?;
            tx.commit()?;
        }
        self.project(&project_id)
    }

    pub fn project(&self, project_id: &str) -> AppResult<Project> {
        self.0
            .lock()?
            .query_row(
                "SELECT id, name, path, order_index, created_at FROM projects WHERE id = ?1",
                [project_id],
                project_from_row,
            )
            .map_err(AppError::from)
    }

    pub fn list_worktrees(&self, project_id: &str) -> AppResult<Vec<Worktree>> {
        let conn = self.0.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, parent_id, branch, title, path, is_main, hidden, created_at
             FROM worktrees WHERE project_id = ?1 ORDER BY is_main DESC, created_at",
        )?;
        let rows = stmt.query_map([project_id], worktree_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn worktree(&self, worktree_id: &str) -> AppResult<Worktree> {
        self.0
            .lock()?
            .query_row(
                "SELECT id, project_id, parent_id, branch, title, path, is_main, hidden, created_at
                 FROM worktrees WHERE id = ?1",
                [worktree_id],
                worktree_from_row,
            )
            .map_err(AppError::from)
    }

    /// Inserts a worktree row using the caller-provided `id`. The id must match
    /// the worktree's on-disk directory name (`.pragma/worktrees/<id>`) so the
    /// database id and the visible path stay a single identity — deep links and
    /// other consumers resolve worktrees by this id.
    pub fn insert_worktree(
        &self,
        id: &str,
        project_id: &str,
        parent_id: &str,
        branch: &str,
        title: Option<String>,
        path: &str,
    ) -> AppResult<Worktree> {
        self.0.lock()?.execute(
            "INSERT INTO worktrees (id, project_id, parent_id, branch, title, path, is_main)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
            params![id, project_id, parent_id, branch, title, path],
        )?;
        self.worktree(id)
    }

    /// Updates the optional display title. An empty/whitespace string clears it.
    pub fn rename_worktree(&self, worktree_id: &str, title: Option<&str>) -> AppResult<Worktree> {
        let normalized = title.map(str::trim).filter(|value| !value.is_empty());
        self.0.lock()?.execute(
            "UPDATE worktrees SET title = ?1 WHERE id = ?2",
            params![normalized, worktree_id],
        )?;
        self.worktree(worktree_id)
    }

    /// Toggles the `hidden` flag — the row stays on disk but disappears from
    /// the sidebar tree. Persistence matches the rest of the worktree state.
    pub fn set_worktree_hidden(&self, worktree_id: &str, hidden: bool) -> AppResult<Worktree> {
        self.0.lock()?.execute(
            "UPDATE worktrees SET hidden = ?1 WHERE id = ?2",
            params![i64::from(hidden), worktree_id],
        )?;
        self.worktree(worktree_id)
    }

    /// Hard-deletes a worktree row. `SQLite` cascades to its tabs (via the
    /// `worktree_id` FK) and to any nested child worktrees.
    pub fn delete_worktree(&self, worktree_id: &str) -> AppResult<()> {
        self.0
            .lock()?
            .execute("DELETE FROM worktrees WHERE id = ?1", [worktree_id])?;
        Ok(())
    }

    pub fn setting(&self, key: &str) -> AppResult<Option<String>> {
        self.0
            .lock()?
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(AppError::from)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        self.0.lock()?.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn list_tabs(&self, project_id: &str) -> AppResult<Vec<Tab>> {
        let conn = self.0.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, worktree_id, kind, title, url, file_path, diff_side, pr_number, user_renamed, order_index, created_at
             FROM tabs WHERE project_id = ?1 ORDER BY order_index, created_at",
        )?;
        let rows = stmt.query_map([project_id], tab_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    // A tab row carries enough locating data that insertion exceeds clippy's
    // default argument ceiling; the columns are all genuinely independent.
    #[allow(clippy::too_many_arguments)]
    pub fn create_tab(
        &self,
        project_id: &str,
        worktree_id: &str,
        kind: TabKind,
        title: Option<String>,
        url: Option<String>,
        file_path: Option<String>,
        diff_side: Option<DiffSide>,
        pr_number: Option<i64>,
    ) -> AppResult<Tab> {
        let id = Uuid::new_v4().to_string();
        {
            let conn = self.0.lock()?;
            let order_index: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tabs WHERE project_id = ?1",
                [project_id],
                |row| row.get(0),
            )?;
            conn.execute(
                "INSERT INTO tabs (id, project_id, worktree_id, kind, title, url, file_path, diff_side, pr_number, order_index)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    id,
                    project_id,
                    worktree_id,
                    kind_as_str(kind),
                    title,
                    url,
                    file_path,
                    diff_side.map(diff_side_as_str),
                    pr_number,
                    order_index
                ],
            )?;
        }
        self.tab(&id)
    }

    /// Renames a tab on behalf of the user (terminal double-click/context menu).
    /// Flips `user_renamed` so subsequent shell-emitted OSC 0/2 title updates are
    /// ignored on this tab.
    pub fn rename_tab(&self, tab_id: &str, title: &str) -> AppResult<Tab> {
        self.0.lock()?.execute(
            "UPDATE tabs SET title = ?1, user_renamed = 1 WHERE id = ?2",
            params![title, tab_id],
        )?;
        self.tab(tab_id)
    }

    /// Updates a tab's title without touching `user_renamed`. Used by the
    /// shell-driven auto-title pipeline (OSC 0/2). The reducer is responsible for
    /// refusing to apply the update when the user has explicitly renamed the
    /// tab; the SQL layer just stores the value it is given.
    pub fn set_tab_title(&self, tab_id: &str, title: &str) -> AppResult<Tab> {
        self.0.lock()?.execute(
            "UPDATE tabs SET title = ?1 WHERE id = ?2",
            params![title, tab_id],
        )?;
        self.tab(tab_id)
    }

    /// Persists the current page URL for a browser tab so the session restores.
    pub fn set_tab_url(&self, tab_id: &str, url: &str) -> AppResult<Tab> {
        self.0.lock()?.execute(
            "UPDATE tabs SET url = ?1 WHERE id = ?2",
            params![url, tab_id],
        )?;
        self.tab(tab_id)
    }

    pub fn delete_tab(&self, tab_id: &str) -> AppResult<()> {
        self.0
            .lock()?
            .execute("DELETE FROM tabs WHERE id = ?1", [tab_id])?;
        Ok(())
    }

    /// Lists the persisted split-pane layouts for a project's worktrees. The
    /// `layout` is the opaque JSON blob the frontend serialized — the backend
    /// never inspects it.
    pub fn list_splits(&self, project_id: &str) -> AppResult<Vec<SplitLayout>> {
        let conn = self.0.lock()?;
        let mut stmt = conn.prepare(
            "SELECT s.worktree_id, s.layout
             FROM splits s
             JOIN worktrees w ON w.id = s.worktree_id
             WHERE w.project_id = ?1",
        )?;
        let rows = stmt.query_map([project_id], |row| {
            Ok(SplitLayout {
                worktree_id: row.get(0)?,
                layout: row.get(1)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    /// Upserts the split-pane layout JSON for a worktree.
    pub fn set_split_layout(&self, worktree_id: &str, layout: &str) -> AppResult<()> {
        self.0.lock()?.execute(
            "INSERT INTO splits (worktree_id, layout, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(worktree_id) DO UPDATE SET
               layout = excluded.layout,
               updated_at = excluded.updated_at",
            params![worktree_id, layout],
        )?;
        Ok(())
    }

    /// Removes a worktree's persisted split layout (it collapsed back to a single
    /// pane / no split).
    pub fn clear_split_layout(&self, worktree_id: &str) -> AppResult<()> {
        self.0
            .lock()?
            .execute("DELETE FROM splits WHERE worktree_id = ?1", [worktree_id])?;
        Ok(())
    }

    fn tab(&self, tab_id: &str) -> AppResult<Tab> {
        self.0
            .lock()?
            .query_row(
                "SELECT id, project_id, worktree_id, kind, title, url, file_path, diff_side, pr_number, user_renamed, order_index, created_at FROM tabs WHERE id = ?1",
                [tab_id],
                tab_from_row,
            )
            .map_err(AppError::from)
    }
}

/// Serializes a tab kind to the lowercase string stored in the `tabs.kind` column.
fn kind_as_str(kind: TabKind) -> &'static str {
    match kind {
        TabKind::Terminal => "terminal",
        TabKind::Browser => "browser",
        TabKind::Editor => "editor",
        TabKind::Diff => "diff",
        TabKind::Log => "log",
        TabKind::PrReview => "pr-review",
    }
}

/// Parses the `tabs.kind` column, defaulting unknown values to a terminal.
fn kind_from_str(value: &str) -> TabKind {
    match value {
        "browser" => TabKind::Browser,
        "editor" => TabKind::Editor,
        "diff" => TabKind::Diff,
        "log" => TabKind::Log,
        "pr-review" => TabKind::PrReview,
        _ => TabKind::Terminal,
    }
}

/// Serializes a diff side to the string stored in the `tabs.diff_side` column.
fn diff_side_as_str(side: DiffSide) -> &'static str {
    match side {
        DiffSide::Committed => "committed",
        DiffSide::Staged => "staged",
        DiffSide::Unstaged => "unstaged",
        DiffSide::Worktree => "worktree",
    }
}

/// Parses the optional `tabs.diff_side` column; unknown values are treated as none.
fn diff_side_from_str(value: Option<String>) -> Option<DiffSide> {
    match value.as_deref() {
        Some("committed") => Some(DiffSide::Committed),
        Some("staged") => Some(DiffSide::Staged),
        Some("unstaged") => Some(DiffSide::Unstaged),
        Some("worktree") => Some(DiffSide::Worktree),
        _ => None,
    }
}

fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        order_index: row.get::<_, i64>(3)?,
        created_at: row.get(4)?,
    })
}

fn worktree_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Worktree> {
    Ok(Worktree {
        id: row.get(0)?,
        project_id: row.get(1)?,
        parent_id: row.get(2)?,
        branch: row.get(3)?,
        title: row.get(4)?,
        path: row.get(5)?,
        is_main: row.get::<_, i64>(6)? == 1,
        hidden: row.get::<_, i64>(7)? == 1,
        created_at: row.get(8)?,
    })
}

fn tab_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Tab> {
    Ok(Tab {
        id: row.get(0)?,
        project_id: row.get(1)?,
        worktree_id: row.get(2)?,
        kind: kind_from_str(&row.get::<_, String>(3)?),
        title: row.get(4)?,
        url: row.get(5)?,
        file_path: row.get(6)?,
        diff_side: diff_side_from_str(row.get::<_, Option<String>>(7)?),
        pr_number: row.get::<_, Option<i64>>(8)?,
        user_renamed: row.get::<_, i64>(9)? == 1,
        order_index: row.get::<_, i64>(10)?,
        created_at: row.get(11)?,
    })
}

#[cfg(test)]
mod tests {
    use super::Db;
    use pragma_constants::TabKind;

    #[test]
    fn migrates_and_cruds_projects_worktrees_and_tabs() {
        let db = Db::in_memory().expect("db should open");
        let project = db
            .insert_project_with_main_worktree(
                "repo".to_string(),
                "/tmp/repo".to_string(),
                "main".to_string(),
            )
            .expect("project should insert");
        let worktrees = db
            .list_worktrees(&project.id)
            .expect("worktrees should list");
        assert_eq!(worktrees.len(), 1);
        let tab = db
            .create_tab(
                &project.id,
                &worktrees[0].id,
                TabKind::Terminal,
                Some("main".to_string()),
                None,
                None,
                None,
                None,
            )
            .expect("tab should insert");
        assert_eq!(tab.kind, TabKind::Terminal);
        assert_eq!(tab.url, None);
        assert_eq!(
            db.list_tabs(&project.id).expect("tabs should list").len(),
            1
        );
        db.delete_tab(&tab.id).expect("tab should delete");
        assert!(db
            .list_tabs(&project.id)
            .expect("tabs should list")
            .is_empty());
    }

    #[test]
    fn browser_tabs_round_trip_kind_and_url() {
        let db = Db::in_memory().expect("db should open");
        let project = db
            .insert_project_with_main_worktree(
                "repo".to_string(),
                "/tmp/repo".to_string(),
                "main".to_string(),
            )
            .expect("project should insert");
        let worktrees = db
            .list_worktrees(&project.id)
            .expect("worktrees should list");
        let tab = db
            .create_tab(
                &project.id,
                &worktrees[0].id,
                TabKind::Browser,
                None,
                Some("https://example.com".to_string()),
                None,
                None,
                None,
            )
            .expect("browser tab should insert");
        assert_eq!(tab.kind, TabKind::Browser);
        assert_eq!(tab.url.as_deref(), Some("https://example.com"));

        let updated = db
            .set_tab_url(&tab.id, "https://example.org")
            .expect("url should update");
        assert_eq!(updated.url.as_deref(), Some("https://example.org"));
        assert_eq!(updated.kind, TabKind::Browser);

        let listed = db.list_tabs(&project.id).expect("tabs should list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, TabKind::Browser);
    }

    #[test]
    fn log_tabs_round_trip_kind() {
        let db = Db::in_memory().expect("db should open");
        let project = db
            .insert_project_with_main_worktree(
                "repo".to_string(),
                "/tmp/repo".to_string(),
                "main".to_string(),
            )
            .expect("project should insert");
        let worktrees = db
            .list_worktrees(&project.id)
            .expect("worktrees should list");
        let tab = db
            .create_tab(
                &project.id,
                &worktrees[0].id,
                TabKind::Log,
                Some("Daemon Logs".to_string()),
                None,
                None,
                None,
                None,
            )
            .expect("log tab should insert");
        assert_eq!(tab.kind, TabKind::Log);

        let listed = db.list_tabs(&project.id).expect("tabs should list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, TabKind::Log);
    }

    #[test]
    fn worktree_rename_normalises_and_clears_empty_titles() {
        let db = Db::in_memory().expect("db should open");
        let project = db
            .insert_project_with_main_worktree(
                "repo".to_string(),
                "/tmp/repo".to_string(),
                "main".to_string(),
            )
            .expect("project should insert");
        let main = db
            .list_worktrees(&project.id)
            .expect("worktrees should list")
            .into_iter()
            .find(|w| w.is_main)
            .expect("main worktree should exist");
        let worktree = db
            .insert_worktree(
                "wt-feature",
                &project.id,
                &main.id,
                "feature",
                None,
                "/tmp/repo/feature",
            )
            .expect("worktree should insert");
        let renamed = db
            .rename_worktree(&worktree.id, Some("  My feature  "))
            .expect("rename should succeed");
        assert_eq!(renamed.title.as_deref(), Some("My feature"));
        let cleared = db
            .rename_worktree(&worktree.id, Some("   "))
            .expect("rename should succeed");
        assert!(cleared.title.is_none());
    }

    #[test]
    fn worktree_hidden_flag_round_trips() {
        let db = Db::in_memory().expect("db should open");
        let project = db
            .insert_project_with_main_worktree(
                "repo".to_string(),
                "/tmp/repo".to_string(),
                "main".to_string(),
            )
            .expect("project should insert");
        let main = db
            .list_worktrees(&project.id)
            .expect("worktrees should list")
            .into_iter()
            .find(|w| w.is_main)
            .expect("main worktree should exist");
        let worktree = db
            .insert_worktree(
                "wt-feature",
                &project.id,
                &main.id,
                "feature",
                None,
                "/tmp/repo/feature",
            )
            .expect("worktree should insert");
        assert!(!worktree.hidden);
        let hidden = db
            .set_worktree_hidden(&worktree.id, true)
            .expect("hide should succeed");
        assert!(hidden.hidden);
        let shown = db
            .set_worktree_hidden(&worktree.id, false)
            .expect("show should succeed");
        assert!(!shown.hidden);
    }

    #[test]
    fn split_layouts_round_trip_and_cascade_on_worktree_delete() {
        let db = Db::in_memory().expect("db should open");
        let project = db
            .insert_project_with_main_worktree(
                "repo".to_string(),
                "/tmp/repo".to_string(),
                "main".to_string(),
            )
            .expect("project should insert");
        let main = db
            .list_worktrees(&project.id)
            .expect("worktrees should list")
            .into_iter()
            .find(|w| w.is_main)
            .expect("main worktree should exist");
        let worktree = db
            .insert_worktree(
                "wt-feature",
                &project.id,
                &main.id,
                "feature",
                None,
                "/tmp/repo/feature",
            )
            .expect("worktree should insert");

        db.set_split_layout(&worktree.id, "{\"kind\":\"split\"}")
            .expect("layout should upsert");
        let listed = db.list_splits(&project.id).expect("splits should list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].worktree_id, worktree.id);
        assert_eq!(listed[0].layout, "{\"kind\":\"split\"}");

        // Upsert overwrites rather than duplicating.
        db.set_split_layout(&worktree.id, "{\"kind\":\"pane\"}")
            .expect("layout should update");
        let updated = db.list_splits(&project.id).expect("splits should list");
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0].layout, "{\"kind\":\"pane\"}");

        // Explicit clear removes the row.
        db.clear_split_layout(&worktree.id)
            .expect("layout should clear");
        assert!(db
            .list_splits(&project.id)
            .expect("splits should list")
            .is_empty());

        // Deleting the worktree cascades to any remaining split row.
        db.set_split_layout(&worktree.id, "{\"kind\":\"split\"}")
            .expect("layout should upsert");
        db.delete_worktree(&worktree.id)
            .expect("worktree should delete");
        assert!(db
            .list_splits(&project.id)
            .expect("splits should list")
            .is_empty());
    }

    #[test]
    fn delete_worktree_cascades_to_tabs_and_children() {
        let db = Db::in_memory().expect("db should open");
        let project = db
            .insert_project_with_main_worktree(
                "repo".to_string(),
                "/tmp/repo".to_string(),
                "main".to_string(),
            )
            .expect("project should insert");
        let main = db
            .list_worktrees(&project.id)
            .expect("worktrees should list")
            .into_iter()
            .find(|w| w.is_main)
            .expect("main worktree should exist");
        let parent = db
            .insert_worktree(
                "wt-parent",
                &project.id,
                &main.id,
                "parent",
                None,
                "/tmp/repo/parent",
            )
            .expect("parent worktree should insert");
        let child = db
            .insert_worktree(
                "wt-child",
                &project.id,
                &parent.id,
                "child",
                None,
                "/tmp/repo/child",
            )
            .expect("child worktree should insert");
        let tab = db
            .create_tab(
                &project.id,
                &parent.id,
                TabKind::Terminal,
                None,
                None,
                None,
                None,
                None,
            )
            .expect("tab should insert");
        db.delete_worktree(&parent.id)
            .expect("delete should succeed");
        let remaining = db
            .list_worktrees(&project.id)
            .expect("worktrees should list");
        // Only the project's main worktree should remain.
        assert_eq!(remaining.len(), 1);
        assert!(remaining[0].is_main);
        assert!(!remaining.iter().any(|w| w.id == child.id));
        assert!(db
            .list_tabs(&project.id)
            .expect("tabs should list")
            .is_empty());
        let _ = tab;
    }

    #[test]
    fn terminal_tab_user_renamed_flag_round_trips() {
        let db = Db::in_memory().expect("db should open");
        let project = db
            .insert_project_with_main_worktree(
                "repo".to_string(),
                "/tmp/repo".to_string(),
                "main".to_string(),
            )
            .expect("project should insert");
        let main = db
            .list_worktrees(&project.id)
            .expect("worktrees should list")
            .into_iter()
            .find(|w| w.is_main)
            .expect("main worktree should exist");
        let tab = db
            .create_tab(
                &project.id,
                &main.id,
                TabKind::Terminal,
                None,
                None,
                None,
                None,
                None,
            )
            .expect("tab should insert");
        // Fresh tabs are not user-renamed — shells may rename them freely.
        assert!(!tab.user_renamed);

        // `rename_tab` is the user-typed path: it flips the flag so the
        // auto-title pipeline (OSC 0/2) cannot clobber the user's choice.
        let renamed = db
            .rename_tab(&tab.id, "Build")
            .expect("rename should succeed");
        assert!(renamed.user_renamed);
        assert_eq!(renamed.title.as_deref(), Some("Build"));

        // `set_tab_title` is the shell-driven auto-title path: it updates the
        // title but explicitly does NOT touch `user_renamed`.
        let auto = db
            .set_tab_title(&tab.id, "user@host: ~/repo")
            .expect("auto-title should succeed");
        assert_eq!(auto.title.as_deref(), Some("user@host: ~/repo"));
        assert!(auto.user_renamed);
    }
}
