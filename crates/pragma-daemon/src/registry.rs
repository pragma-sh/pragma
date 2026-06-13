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
