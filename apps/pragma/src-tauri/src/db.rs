use std::path::Path;
use std::sync::Mutex;

use pragma_constants::{Project, Tab, TabKind, Worktree};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

pub struct Db(pub Mutex<Connection>);

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
               order_index  INTEGER NOT NULL,
               created_at   TEXT NOT NULL DEFAULT (datetime('now'))
             );
             CREATE INDEX IF NOT EXISTS idx_tabs_project ON tabs(project_id);",
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

    pub fn insert_worktree(
        &self,
        project_id: &str,
        parent_id: &str,
        branch: &str,
        title: Option<String>,
        path: &str,
    ) -> AppResult<Worktree> {
        let id = Uuid::new_v4().to_string();
        self.0.lock()?.execute(
            "INSERT INTO worktrees (id, project_id, parent_id, branch, title, path, is_main)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
            params![id, project_id, parent_id, branch, title, path],
        )?;
        self.worktree(&id)
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
            "SELECT id, project_id, worktree_id, kind, title, url, order_index, created_at
             FROM tabs WHERE project_id = ?1 ORDER BY order_index, created_at",
        )?;
        let rows = stmt.query_map([project_id], tab_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn create_tab(
        &self,
        project_id: &str,
        worktree_id: &str,
        kind: TabKind,
        title: Option<String>,
        url: Option<String>,
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
                "INSERT INTO tabs (id, project_id, worktree_id, kind, title, url, order_index)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    project_id,
                    worktree_id,
                    kind_as_str(kind),
                    title,
                    url,
                    order_index
                ],
            )?;
        }
        self.tab(&id)
    }

    pub fn rename_tab(&self, tab_id: &str, title: &str) -> AppResult<Tab> {
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

    fn tab(&self, tab_id: &str) -> AppResult<Tab> {
        self.0
            .lock()?
            .query_row(
                "SELECT id, project_id, worktree_id, kind, title, url, order_index, created_at FROM tabs WHERE id = ?1",
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
    }
}

/// Parses the `tabs.kind` column, defaulting unknown values to a terminal.
fn kind_from_str(value: &str) -> TabKind {
    match value {
        "browser" => TabKind::Browser,
        _ => TabKind::Terminal,
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
        order_index: row.get::<_, i64>(6)?,
        created_at: row.get(7)?,
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
            .insert_worktree(&project.id, &main.id, "feature", None, "/tmp/repo/feature")
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
            .insert_worktree(&project.id, &main.id, "feature", None, "/tmp/repo/feature")
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
            .insert_worktree(&project.id, &main.id, "parent", None, "/tmp/repo/parent")
            .expect("parent worktree should insert");
        let child = db
            .insert_worktree(&project.id, &parent.id, "child", None, "/tmp/repo/child")
            .expect("child worktree should insert");
        let tab = db
            .create_tab(&project.id, &parent.id, TabKind::Terminal, None, None)
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
}
