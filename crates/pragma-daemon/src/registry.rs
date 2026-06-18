use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use pragma_protocol::{AgentReportPayload, EventFrame};
use thiserror::Error;

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
    socket_path: PathBuf,
    agent_statuses: Mutex<HashMap<AgentKey, AgentReportPayload>>,
    agent_subscribers: Mutex<Vec<Sender<EventFrame>>>,
}

type AgentKey = (String, String, String);

impl Registry {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            socket_path,
            agent_statuses: Mutex::new(HashMap::new()),
            agent_subscribers: Mutex::new(Vec::new()),
        }
    }

    pub fn spawn(
        &self,
        session_id: String,
        worktree_id: String,
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
        let session = Session::spawn(
            session_id.clone(),
            worktree_id,
            cwd,
            cols,
            rows,
            self.socket_path.to_string_lossy().into_owned(),
        )?;
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
        self.clear_agents_for_tab(session_id);
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
            let Some(session) = sessions.get(id).cloned() else {
                continue;
            };
            // Only stop tracking a session once it is actually dead. Removing it
            // first and ignoring a kill failure would orphan a still-running
            // shell in a deleted worktree with no way to reach it again.
            if session.kill().is_ok() {
                sessions.remove(id);
                self.clear_agents_for_tab(id);
                killed += 1;
            }
        }
        Ok(killed)
    }

    pub fn report_agent(&self, payload: AgentReportPayload) -> Result<(), RegistryError> {
        let event = agent_event(&payload);
        let key = (
            payload.worktree_id.clone(),
            payload.tab_id.clone(),
            payload.agent.clone(),
        );
        self.agent_statuses
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?
            .insert(key, payload);
        self.broadcast_agent(&event);
        Ok(())
    }

    pub fn subscribe_agents(
        &self,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), RegistryError> {
        let statuses = self
            .agent_statuses
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        let (tx, rx) = mpsc::channel();
        self.agent_subscribers
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?
            .push(tx);
        Ok((statuses.values().map(agent_event).collect(), rx))
    }

    pub fn clear_agents_for_tab(&self, tab_id: &str) {
        if let Ok(mut statuses) = self.agent_statuses.lock() {
            statuses.retain(|(_, status_tab_id, _), _| status_tab_id != tab_id);
        }
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

    fn broadcast_agent(&self, event: &EventFrame) {
        if let Ok(mut subscribers) = self.agent_subscribers.lock() {
            subscribers.retain(|tx| tx.send(event.clone()).is_ok());
        }
    }
}

fn agent_event(payload: &AgentReportPayload) -> EventFrame {
    EventFrame::Agent {
        worktree_id: payload.worktree_id.clone(),
        tab_id: payload.tab_id.clone(),
        agent: payload.agent.clone(),
        status: payload.status,
        attention_kind: payload.attention_kind,
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
            .spawn(id.clone(), "worktree-1".to_string(), cwd, 80, 24)
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
