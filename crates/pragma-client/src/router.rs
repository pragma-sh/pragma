//! Client-local router database.
//!
//! This `SQLite` database is device-local. It maps projects to local/remote hosts
//! and stores presentation preferences that should not live in the host-side
//! per-project databases under `<project>/.pragma/`.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use thiserror::Error;

/// Result type for router DB operations.
pub type RouterResult<T> = Result<T, RouterError>;

/// Router DB errors.
#[derive(Debug, Error)]
pub enum RouterError {
    /// `SQLite` operation failed.
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    /// JSON preferences failed to parse or serialize.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    /// Router DB connection lock was poisoned.
    #[error("router db lock poisoned")]
    Lock,
}

/// A project-to-host route stored in the client-local router DB.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectRoute {
    /// Stable client-side project key. In the current local-only UI this is the
    /// project path; remote host-management UI can replace it with explicit IDs.
    pub project_key: String,
    /// Host id. Use `local` for the local machine.
    pub host_id: String,
    /// Device-local preferences as JSON.
    pub preferences: Value,
}

/// SQLite-backed router DB.
pub struct RouterDb {
    conn: Mutex<Connection>,
}

impl RouterDb {
    /// Opens or creates a router DB at `path`.
    pub fn open(path: impl AsRef<Path>) -> RouterResult<Self> {
        let conn = Connection::open(path)?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    /// Opens an in-memory router DB, intended for tests.
    pub fn open_in_memory() -> RouterResult<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    /// Returns the route for `project_key`, if one exists.
    pub fn project_route(&self, project_key: &str) -> RouterResult<Option<ProjectRoute>> {
        let conn = self.connection()?;
        conn.query_row(
            "SELECT project_key, host_id, preferences FROM project_routes WHERE project_key = ?1",
            params![project_key],
            |row| {
                let preferences: String = row.get(2)?;
                Ok((row.get(0)?, row.get(1)?, preferences))
            },
        )
        .optional()?
        .map(|(project_key, host_id, preferences)| {
            Ok(ProjectRoute {
                project_key,
                host_id,
                preferences: serde_json::from_str(&preferences)?,
            })
        })
        .transpose()
    }

    /// Returns every stored project route.
    pub fn project_routes(&self) -> RouterResult<Vec<ProjectRoute>> {
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            "SELECT project_key, host_id, preferences FROM project_routes ORDER BY project_key",
        )?;
        let rows = statement.query_map([], |row| {
            let preferences: String = row.get(2)?;
            Ok((row.get(0)?, row.get(1)?, preferences))
        })?;
        rows.map(|row| {
            let (project_key, host_id, preferences) = row?;
            Ok(ProjectRoute {
                project_key,
                host_id,
                preferences: serde_json::from_str(&preferences)?,
            })
        })
        .collect()
    }

    /// Inserts or replaces a route for a project.
    pub fn set_project_route(&self, route: &ProjectRoute) -> RouterResult<()> {
        let preferences = serde_json::to_string(&route.preferences)?;
        let conn = self.connection()?;
        conn.execute(
            "INSERT INTO project_routes (project_key, host_id, preferences, updated_at) \
             VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) \
             ON CONFLICT(project_key) DO UPDATE SET \
             host_id = excluded.host_id, \
             preferences = excluded.preferences, \
             updated_at = excluded.updated_at",
            params![route.project_key, route.host_id, preferences],
        )?;
        Ok(())
    }

    fn migrate(&self) -> RouterResult<()> {
        let conn = self.connection()?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS project_routes (
               project_key TEXT PRIMARY KEY NOT NULL,
               host_id TEXT NOT NULL,
               preferences TEXT NOT NULL DEFAULT '{}',
               updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             );",
        )?;
        Ok(())
    }

    fn connection(&self) -> RouterResult<MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| RouterError::Lock)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ProjectRoute, RouterDb};

    #[test]
    fn stores_and_loads_project_routes() {
        let db = RouterDb::open_in_memory().expect("router db");
        let route = ProjectRoute {
            project_key: "/repo".to_string(),
            host_id: "local".to_string(),
            preferences: json!({ "sidebarWidth": 320 }),
        };

        db.set_project_route(&route).expect("set route");

        assert_eq!(db.project_route("/repo").expect("load route"), Some(route),);
    }

    #[test]
    fn lists_project_routes() {
        let db = RouterDb::open_in_memory().expect("router db");
        let first = ProjectRoute {
            project_key: "/a".to_string(),
            host_id: "local".to_string(),
            preferences: json!({}),
        };
        let second = ProjectRoute {
            project_key: "/b".to_string(),
            host_id: "ssh://u@example.com:22".to_string(),
            preferences: json!({ "authMethod": "agent" }),
        };

        db.set_project_route(&second).expect("set second");
        db.set_project_route(&first).expect("set first");

        assert_eq!(db.project_routes().expect("routes"), vec![first, second]);
    }
}
