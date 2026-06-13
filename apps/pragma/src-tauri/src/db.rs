use std::path::Path;
use std::sync::Mutex;

use pragma_constants::{Project, Tab, Worktree};
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
        self.0.lock()?.execute_batch(
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
             CREATE INDEX IF NOT EXISTS idx_tabs_project ON tabs(project_id);
             PRAGMA user_version = 1;",
        )?;
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
            "SELECT id, project_id, parent_id, branch, title, path, is_main, created_at
             FROM worktrees WHERE project_id = ?1 ORDER BY is_main DESC, created_at",
        )?;
        let rows = stmt.query_map([project_id], worktree_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn worktree(&self, worktree_id: &str) -> AppResult<Worktree> {
        self.0
            .lock()?
            .query_row(
                "SELECT id, project_id, parent_id, branch, title, path, is_main, created_at
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
            "SELECT id, project_id, worktree_id, title, order_index, created_at
             FROM tabs WHERE project_id = ?1 ORDER BY order_index, created_at",
        )?;
        let rows = stmt.query_map([project_id], tab_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn create_tab(
        &self,
        project_id: &str,
        worktree_id: &str,
        title: Option<String>,
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
                "INSERT INTO tabs (id, project_id, worktree_id, title, order_index)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, project_id, worktree_id, title, order_index],
            )?;
        }
        self.tab(&id)
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
                "SELECT id, project_id, worktree_id, title, order_index, created_at FROM tabs WHERE id = ?1",
                [tab_id],
                tab_from_row,
            )
            .map_err(AppError::from)
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
        created_at: row.get(7)?,
    })
}

fn tab_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Tab> {
    Ok(Tab {
        id: row.get(0)?,
        project_id: row.get(1)?,
        worktree_id: row.get(2)?,
        title: row.get(3)?,
        order_index: row.get::<_, i64>(4)?,
        created_at: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::Db;

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
            .create_tab(&project.id, &worktrees[0].id, Some("main".to_string()))
            .expect("tab should insert");
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
}
