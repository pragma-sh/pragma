use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Mutex;

use pragma_constants::{Project, Tab, Worktree};

use crate::error::AppError;

const USER_VERSION: i32 = 1;

/// Wraps a `SQLite` connection for thread-safe access.
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Open the database at the given path, running migrations if needed.
    pub fn open(path: PathBuf) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&path)?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), AppError> {
        let conn = self.conn.lock().unwrap();
        let version: i32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version < USER_VERSION {
            conn.execute_batch(include_str!("../sql/schema.sql"))?;
            conn.pragma_update(None, "user_version", USER_VERSION)?;
        }
        Ok(())
    }

    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
    }

    // ── Projects ──────────────────────────────────────

    pub fn list_projects(&self) -> Result<Vec<Project>, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, path, order_index, created_at FROM projects ORDER BY order_index",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                order_index: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn add_project(
        &self,
        id: &str,
        name: &str,
        path: &str,
        order_index: i64,
    ) -> Result<Project, AppError> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO projects (id, name, path, order_index) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, path, order_index],
        )?;
        let mut stmt = conn.prepare("SELECT created_at FROM projects WHERE id = ?1")?;
        let created_at: String = stmt.query_row(params![id], |row| row.get(0))?;
        Ok(Project {
            id: id.to_string(),
            name: name.to_string(),
            path: path.to_string(),
            order_index,
            created_at,
        })
    }

    pub fn get_project(&self, id: &str) -> Result<Option<Project>, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, path, order_index, created_at FROM projects WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                order_index: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    pub fn get_project_by_path(&self, path: &str) -> Result<Option<Project>, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, path, order_index, created_at FROM projects WHERE path = ?1",
        )?;
        let mut rows = stmt.query_map(params![path], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                order_index: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    pub fn delete_project(&self, id: &str) -> Result<(), AppError> {
        let conn = self.conn();
        conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ── Worktrees ─────────────────────────────────────

    pub fn list_worktrees(&self, project_id: &str) -> Result<Vec<Worktree>, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, parent_id, branch, title, path, is_main, created_at FROM worktrees WHERE project_id = ?1 ORDER BY is_main DESC, created_at",
        )?;
        let rows = stmt.query_map(params![project_id], |row| {
            Ok(Worktree {
                id: row.get(0)?,
                project_id: row.get(1)?,
                parent_id: row.get(2)?,
                branch: row.get(3)?,
                title: row.get(4)?,
                path: row.get(5)?,
                is_main: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn add_worktree(
        &self,
        id: &str,
        project_id: &str,
        parent_id: Option<&str>,
        branch: &str,
        title: Option<&str>,
        path: &str,
        is_main: bool,
    ) -> Result<Worktree, AppError> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO worktrees (id, project_id, parent_id, branch, title, path, is_main) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, project_id, parent_id, branch, title, path, i32::from(is_main)],
        )?;
        let mut stmt = conn.prepare("SELECT created_at FROM worktrees WHERE id = ?1")?;
        let created_at: String = stmt.query_row(params![id], |row| row.get(0))?;
        Ok(Worktree {
            id: id.to_string(),
            project_id: project_id.to_string(),
            parent_id: parent_id.map(String::from),
            branch: branch.to_string(),
            title: title.map(String::from),
            path: path.to_string(),
            is_main: i64::from(is_main),
            created_at,
        })
    }

    pub fn get_worktree(&self, id: &str) -> Result<Option<Worktree>, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, parent_id, branch, title, path, is_main, created_at FROM worktrees WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |row| {
            Ok(Worktree {
                id: row.get(0)?,
                project_id: row.get(1)?,
                parent_id: row.get(2)?,
                branch: row.get(3)?,
                title: row.get(4)?,
                path: row.get(5)?,
                is_main: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    pub fn delete_worktree(&self, id: &str) -> Result<(), AppError> {
        let conn = self.conn();
        conn.execute("DELETE FROM worktrees WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ── Settings ──────────────────────────────────────

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query_map(params![key], |row| row.get(0))?;
        Ok(rows.next().transpose()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), AppError> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // ── Tabs ──────────────────────────────────────────

    pub fn list_tabs(&self, project_id: &str) -> Result<Vec<Tab>, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, worktree_id, title, order_index, created_at FROM tabs WHERE project_id = ?1 ORDER BY order_index",
        )?;
        let rows = stmt.query_map(params![project_id], |row| {
            Ok(Tab {
                id: row.get(0)?,
                project_id: row.get(1)?,
                worktree_id: row.get(2)?,
                title: row.get(3)?,
                order_index: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn add_tab(
        &self,
        id: &str,
        project_id: &str,
        worktree_id: &str,
        title: Option<&str>,
        order_index: i64,
    ) -> Result<Tab, AppError> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO tabs (id, project_id, worktree_id, title, order_index) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, project_id, worktree_id, title, order_index],
        )?;
        let mut stmt = conn.prepare("SELECT created_at FROM tabs WHERE id = ?1")?;
        let created_at: String = stmt.query_row(params![id], |row| row.get(0))?;
        Ok(Tab {
            id: id.to_string(),
            project_id: project_id.to_string(),
            worktree_id: worktree_id.to_string(),
            title: title.map(String::from),
            order_index,
            created_at,
        })
    }

    pub fn get_tab(&self, id: &str) -> Result<Option<Tab>, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, worktree_id, title, order_index, created_at FROM tabs WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |row| {
            Ok(Tab {
                id: row.get(0)?,
                project_id: row.get(1)?,
                worktree_id: row.get(2)?,
                title: row.get(3)?,
                order_index: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    pub fn delete_tab(&self, id: &str) -> Result<(), AppError> {
        let conn = self.conn();
        conn.execute("DELETE FROM tabs WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_db() -> Db {
        Db::open(std::path::PathBuf::from(":memory:")).unwrap()
    }

    #[test]
    fn crud_projects() {
        let db = setup_db();
        let project = db.add_project("p1", "test-proj", "/tmp/test", 0).unwrap();
        assert_eq!(project.name, "test-proj");
        let list = db.list_projects().unwrap();
        assert_eq!(list.len(), 1);
        db.delete_project("p1").unwrap();
        assert_eq!(db.list_projects().unwrap().len(), 0);
    }

    #[test]
    fn settings_roundtrip() {
        let db = setup_db();
        assert!(db.get_setting("missing").unwrap().is_none());
        db.set_setting("key1", "val1").unwrap();
        assert_eq!(db.get_setting("key1").unwrap(), Some("val1".into()));
    }

    #[test]
    fn tabs_crud() {
        let db = setup_db();
        db.add_project("proj1", "p", "/tmp/p", 0).unwrap();
        db.add_worktree("wt1", "proj1", None, "main", None, "/tmp/p", true)
            .unwrap();
        let tab = db.add_tab("t1", "proj1", "wt1", Some("Shell"), 0).unwrap();
        assert_eq!(tab.title, Some("Shell".into()));
        let tabs = db.list_tabs("proj1").unwrap();
        assert_eq!(tabs.len(), 1);
        db.delete_tab("t1").unwrap();
        assert_eq!(db.list_tabs("proj1").unwrap().len(), 0);
    }
}
