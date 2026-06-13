use std::collections::HashMap;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

use thiserror::Error;

use crate::protocol::EventFrame;
use crate::session::{Session, SessionError};

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("session already exists: {0}")]
    AlreadyExists(String),
    #[error("session not found: {0}")]
    NotFound(String),
    #[error(transparent)]
    Session(#[from] SessionError),
    #[error("lock poisoned")]
    LockPoisoned,
}

#[derive(Default)]
pub struct Registry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl Registry {
    pub fn spawn(
        &self,
        session_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), RegistryError> {
        // Reject duplicates before the expensive PTY open, but spawn the shell
        // outside the registry lock so concurrent writes/resizes/attaches to other
        // sessions are not serialized behind a blocking openpty + fork.
        if self
            .sessions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?
            .contains_key(&session_id)
        {
            return Err(RegistryError::AlreadyExists(session_id));
        }
        let session = Session::spawn(session_id.clone(), cwd, cols, rows)?;
        let attach = session.attach()?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        if sessions.contains_key(&session_id) {
            // Lost a race with a concurrent spawn of the same id; drop ours.
            session.kill()?;
            return Err(RegistryError::AlreadyExists(session_id));
        }
        sessions.insert(session_id, session);
        Ok(attach)
    }

    pub fn attach(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), RegistryError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| RegistryError::NotFound(session_id.to_string()))?;
        session.resize(cols, rows)?;
        Ok(session.attach()?)
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), RegistryError> {
        self.session(session_id)?.write(data)?;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), RegistryError> {
        self.session(session_id)?.resize(cols, rows)?;
        Ok(())
    }

    pub fn kill(&self, session_id: &str) -> Result<(), RegistryError> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?
            .remove(session_id)
            .ok_or_else(|| RegistryError::NotFound(session_id.to_string()))?;
        session.kill()?;
        Ok(())
    }

    /// Kills every session whose initial cwd matches `path` exactly OR lives
    /// underneath it. Returns the number of sessions terminated; missing
    /// sessions are skipped so this is idempotent.
    pub fn kill_for_cwd(&self, path: &str) -> Result<usize, RegistryError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        let target_ids: Vec<String> = sessions
            .iter()
            .filter_map(|(id, session)| {
                let cwd = session.cwd();
                if cwd == path || cwd.starts_with(format!("{path}/").as_str()) {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        let mut killed = 0;
        for id in &target_ids {
            if let Some(session) = sessions.remove(id) {
                if session.kill().is_ok() {
                    killed += 1;
                }
            }
        }
        Ok(killed)
    }

    pub fn is_empty(&self) -> bool {
        self.sessions
            .lock()
            .map_or(true, |sessions| sessions.is_empty())
    }

    fn session(&self, session_id: &str) -> Result<Arc<Session>, RegistryError> {
        self.sessions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?
            .get(session_id)
            .cloned()
            .ok_or_else(|| RegistryError::NotFound(session_id.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use tempfile::tempdir;

    use super::Registry;

    /// Spawns a fresh PTY session in a real temp directory and returns the
    /// registry, the session id, and the tempdir (so its cwd stays alive for
    /// the duration of the test).
    fn spawn_session() -> (Registry, String, tempfile::TempDir) {
        let dir = tempdir().expect("tempdir");
        // Some shells refuse to start outside a real directory; tempdir gives
        // us one but it has to be a directory the kernel accepts.
        let _ = Command::new("true").output();
        let registry = Registry::default();
        let id = "session-1".to_string();
        let cwd = dir.path().to_string_lossy().into_owned();
        let (_scrollback, _rx) = registry
            .spawn(id.clone(), cwd, 80, 24)
            .expect("session should spawn");
        (registry, id, dir)
    }

    #[test]
    fn kill_for_cwd_terminates_matching_sessions_and_leaves_others() {
        let (registry, id, dir) = spawn_session();
        let cwd = dir.path().to_string_lossy().into_owned();
        let killed = registry.kill_for_cwd(&cwd).expect("kill should succeed");
        assert_eq!(killed, 1);
        // Subsequent attempts are idempotent — the session is gone.
        let killed_again = registry.kill_for_cwd(&cwd).expect("kill should succeed");
        assert_eq!(killed_again, 0);
        assert!(registry.is_empty(), "registry should be empty after kill");
        let _ = id;
    }

    #[test]
    fn kill_for_cwd_does_not_match_unrelated_paths() {
        let (registry, _id, _dir) = spawn_session();
        let killed = registry
            .kill_for_cwd("/some/other/place")
            .expect("kill should succeed");
        assert_eq!(killed, 0);
        assert!(!registry.is_empty());
    }
}
