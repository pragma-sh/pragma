use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};

use crate::protocol::{write_frame, Response};
use crate::session::Session;

/// A handle for writing responses back to a connected client.
pub type ClientWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// Central registry of all PTY sessions in the daemon.
pub struct Registry {
    sessions: HashMap<String, Session>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    /// Return the number of active sessions.
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    /// Spawn a new PTY session.
    pub fn spawn(
        &mut self,
        session_id: String,
        cwd: &str,
        cols: u16,
        rows: u16,
        client: &ClientWriter,
    ) {
        match Session::spawn(session_id.clone(), cwd, cols, rows) {
            Ok(session) => {
                session.add_subscriber(Arc::clone(client));
                self.sessions.insert(session_id, session);
                let mut w = client.lock().unwrap();
                let _ = write_frame(&mut *w, &Response::Ok);
            }
            Err(e) => {
                let mut w = client.lock().unwrap();
                let _ = write_frame(
                    &mut *w,
                    &Response::Error {
                        message: format!("Failed to spawn session: {e}"),
                    },
                );
            }
        }
    }

    /// Attach to an existing session.
    ///
    /// First replays the scrollback ring, then adds the client as a subscriber
    /// for live output.
    pub fn attach(&self, session_id: &str, cols: u16, rows: u16, client: &ClientWriter) {
        let session = if let Some(s) = self.sessions.get(session_id) {
            s
        } else {
            let mut w = client.lock().unwrap();
            let _ = write_frame(
                &mut *w,
                &Response::Error {
                    message: format!("Session not found: {session_id}"),
                },
            );
            return;
        };

        if let Err(e) = session.resize(cols, rows) {
            let mut w = client.lock().unwrap();
            let _ = write_frame(
                &mut *w,
                &Response::Error {
                    message: format!("Resize failed: {e}"),
                },
            );
            return;
        }

        let scrollback_text = {
            let sb = session.scrollback.lock().unwrap();
            sb.as_string()
        };

        if !scrollback_text.is_empty() {
            let mut w = client.lock().unwrap();
            let _ = write_frame(
                &mut *w,
                &Response::Scrollback {
                    session_id: session_id.to_string(),
                    data: scrollback_text,
                },
            );
        }

        session.add_subscriber(Arc::clone(client));

        let mut w = client.lock().unwrap();
        let _ = write_frame(&mut *w, &Response::Ok);
    }

    /// Write data to a session's PTY.
    pub fn write(&mut self, session_id: &str, data: &str, client: &ClientWriter) {
        let session = if let Some(s) = self.sessions.get_mut(session_id) {
            s
        } else {
            let mut w = client.lock().unwrap();
            let _ = write_frame(
                &mut *w,
                &Response::Error {
                    message: format!("Session not found: {session_id}"),
                },
            );
            return;
        };

        if let Err(e) = session.write(data) {
            let mut w = client.lock().unwrap();
            let _ = write_frame(
                &mut *w,
                &Response::Error {
                    message: format!("Write failed: {e}"),
                },
            );
        }
    }

    /// Resize a session's PTY.
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16, client: &ClientWriter) {
        let session = if let Some(s) = self.sessions.get(session_id) {
            s
        } else {
            let mut w = client.lock().unwrap();
            let _ = write_frame(
                &mut *w,
                &Response::Error {
                    message: format!("Session not found: {session_id}"),
                },
            );
            return;
        };

        if let Err(e) = session.resize(cols, rows) {
            let mut w = client.lock().unwrap();
            let _ = write_frame(
                &mut *w,
                &Response::Error {
                    message: format!("Resize failed: {e}"),
                },
            );
        }
    }

    /// Kill a session. The reader thread will unblock and send an Exit frame.
    pub fn kill(&mut self, session_id: &str) -> bool {
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.kill();
            true
        } else {
            false
        }
    }

    /// Remove a session from the registry (called after Exit is sent).
    pub fn remove(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    /// Drop all sessions (on daemon shutdown).
    pub fn clear(&mut self) {
        for (_, session) in &mut self.sessions {
            session.kill();
        }
        self.sessions.clear();
    }
}
