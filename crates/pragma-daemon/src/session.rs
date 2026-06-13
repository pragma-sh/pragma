use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use thiserror::Error;

use crate::protocol::EventFrame;

const SCROLLBACK_LIMIT: usize = 10_000;

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("pty error: {0}")]
    Pty(#[from] anyhow_pty::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("lock poisoned")]
    LockPoisoned,
}

mod anyhow_pty {
    pub type Error = anyhow::Error;
}

type PtyChild = Box<dyn portable_pty::Child + Send + Sync>;

pub struct Session {
    id: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Option<PtyChild>>,
    scrollback: Mutex<Scrollback>,
    subscribers: Mutex<Vec<Sender<EventFrame>>>,
}

impl Session {
    pub fn spawn(id: String, cwd: String, cols: u16, rows: u16) -> Result<Arc<Self>, SessionError> {
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = CommandBuilder::new(shell_path());
        command.arg("-l");
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let child = pair.slave.spawn_command(command)?;
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        drop(pair.slave);

        let session = Arc::new(Self {
            id,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(Some(child)),
            scrollback: Mutex::new(Scrollback::new(SCROLLBACK_LIMIT)),
            subscribers: Mutex::new(Vec::new()),
        });
        Self::start_reader(Arc::clone(&session), reader);
        Ok(session)
    }

    pub fn attach(&self) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), SessionError> {
        // Hold the scrollback lock while registering the subscriber so the reader
        // thread cannot broadcast an event that lands in both the snapshot and the
        // channel — that would replay duplicated output to the freshly attached
        // client. Taking both locks together makes attach atomic w.r.t. broadcast.
        let scrollback_guard = self
            .scrollback
            .lock()
            .map_err(|_| SessionError::LockPoisoned)?;
        let (tx, rx) = mpsc::channel();
        self.subscribers
            .lock()
            .map_err(|_| SessionError::LockPoisoned)?
            .push(tx);
        let scrollback = scrollback_guard.frames();
        Ok((scrollback, rx))
    }

    pub fn write(&self, data: &str) -> Result<(), SessionError> {
        let mut writer = self.writer.lock().map_err(|_| SessionError::LockPoisoned)?;
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        self.master
            .lock()
            .map_err(|_| SessionError::LockPoisoned)?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        Ok(())
    }

    pub fn kill(&self) -> Result<(), SessionError> {
        if let Some(mut child) = self
            .child
            .lock()
            .map_err(|_| SessionError::LockPoisoned)?
            .take()
        {
            child.kill()?;
        }
        Ok(())
    }

    fn start_reader(session: Arc<Self>, mut reader: Box<dyn Read + Send>) {
        thread::spawn(move || {
            let mut decoder = Utf8Carry::default();
            let mut buf = [0_u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        for data in decoder.push(&buf[..n]) {
                            session.broadcast(&EventFrame::Output {
                                session_id: session.id.clone(),
                                data,
                            });
                        }
                    }
                }
            }
            if let Some(data) = decoder.finish() {
                session.broadcast(&EventFrame::Output {
                    session_id: session.id.clone(),
                    data,
                });
            }
            let code = session
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.take())
                .and_then(|mut child| child.wait().ok())
                .map(|status| i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
            session.broadcast(&EventFrame::Exit {
                session_id: session.id.clone(),
                code,
            });
        });
    }

    fn broadcast(&self, event: &EventFrame) {
        if let Ok(mut scrollback) = self.scrollback.lock() {
            scrollback.push(event.clone());
        }
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.retain(|tx| tx.send(event.clone()).is_ok());
        }
    }
}

#[derive(Default)]
pub struct Utf8Carry {
    carry: Vec<u8>,
}

impl Utf8Carry {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.carry.extend_from_slice(bytes);
        match std::str::from_utf8(&self.carry) {
            Ok(text) => {
                let out = text.to_string();
                self.carry.clear();
                vec![out]
            }
            Err(err) => {
                let valid = err.valid_up_to();
                if valid == 0 {
                    return Vec::new();
                }
                let out = String::from_utf8(self.carry[..valid].to_vec()).ok();
                let rest = self.carry[valid..].to_vec();
                self.carry = rest;
                out.into_iter().collect()
            }
        }
    }

    pub fn finish(self) -> Option<String> {
        if self.carry.is_empty() {
            None
        } else {
            String::from_utf8(self.carry).ok()
        }
    }
}

pub struct Scrollback {
    limit: usize,
    frames: VecDeque<EventFrame>,
}

impl Scrollback {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            frames: VecDeque::new(),
        }
    }

    pub fn push(&mut self, frame: EventFrame) {
        if self.frames.len() == self.limit {
            self.frames.pop_front();
        }
        self.frames.push_back(frame);
    }

    pub fn frames(&self) -> Vec<EventFrame> {
        self.frames.iter().cloned().collect()
    }
}

fn shell_path() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".to_string()
        } else {
            "/bin/sh".to_string()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{Scrollback, Utf8Carry};
    use crate::protocol::EventFrame;

    #[test]
    fn preserves_utf8_boundaries() {
        let mut carry = Utf8Carry::default();
        assert!(carry.push(&[0xf0, 0x9f]).is_empty());
        assert_eq!(carry.push(&[0x98, 0x80]), vec!["😀".to_string()]);
    }

    #[test]
    fn scrollback_is_bounded() {
        let mut scrollback = Scrollback::new(2);
        for data in ["one", "two", "three"] {
            scrollback.push(EventFrame::Output {
                session_id: "s".to_string(),
                data: data.to_string(),
            });
        }
        assert_eq!(scrollback.frames().len(), 2);
    }
}
