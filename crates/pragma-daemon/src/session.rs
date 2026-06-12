use std::io::Write;
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use crate::protocol::{write_frame, Response};
use crate::registry::ClientWriter;

const READ_BUF_SIZE: usize = 8192;
const MAX_SCROLLBACK: usize = 256 * 1024;

/// Find the smallest index >= `min` that is a valid UTF-8 start byte.
fn find_utf8_boundary(data: &[u8], min: usize) -> usize {
    let mut i = min;
    while i < data.len() && (data[i] & 0xC0) == 0x80 {
        i += 1;
    }
    i
}

/// A bounded scrollback ring shared between the reader thread and attach handlers.
pub struct Scrollback {
    buf: Vec<u8>,
    max_len: usize,
}

impl Scrollback {
    fn new(max_len: usize) -> Self {
        Self {
            buf: Vec::new(),
            max_len,
        }
    }

    fn append(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
        if self.buf.len() > self.max_len {
            let excess = self.buf.len() - self.max_len;
            let truncate_at = find_utf8_boundary(&self.buf, excess);
            self.buf.drain(..truncate_at);
        }
    }

    pub fn as_string(&self) -> String {
        String::from_utf8_lossy(&self.buf).into_owned()
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }
}

/// An active PTY session inside the daemon.
///
/// Holds the PTY master (for resize), the writer, and shared state between
/// the reader thread and attach handlers.
pub struct Session {
    /// The PTY master — kept for resize operations after the writer is taken.
    #[allow(dead_code)]
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// Writer to the PTY master. Dropping kills the child.
    writer: Option<Box<dyn Write + Send>>,
    /// Shared scrollback ring, also written by the reader thread.
    pub scrollback: Arc<Mutex<Scrollback>>,
    /// Connected clients receiving output frames.
    pub subscribers: Arc<Mutex<Vec<ClientWriter>>>,
}

impl Session {
    /// Spawn a new PTY session.
    ///
    /// Launches `$SHELL -l` in `cwd` with `TERM=xterm-256color` and
    /// `COLORTERM=truecolor`. Starts a reader thread that fans output to
    /// attached clients and appends to the scrollback ring.
    pub fn spawn(
        session_id: String,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/sh".to_string()
            }
        });

        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let mut child = pair.slave.spawn_command(cmd)?;
        let _child_pid = child.process_id().unwrap_or(0);
        let master = pair.master;
        let writer = master
            .take_writer()
            .map_err(|e| format!("PTY writer: {e}"))?;

        let scrollback = Arc::new(Mutex::new(Scrollback::new(MAX_SCROLLBACK)));
        let subscribers: Arc<Mutex<Vec<ClientWriter>>> = Arc::new(Mutex::new(Vec::new()));

        let sb = Arc::clone(&scrollback);
        let subs = Arc::clone(&subscribers);
        let sid = session_id;

        let mut reader = master
            .try_clone_reader()
            .map_err(|e| format!("PTY reader clone: {e}"))?;

        thread::spawn(move || {
            let mut buf = [0u8; READ_BUF_SIZE];
            let mut carry: Vec<u8> = Vec::new();

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let exit_code = child.wait().ok().map(|s| s.exit_code() as i32);
                        let resp = Response::Exit {
                            session_id: sid.clone(),
                            code: exit_code,
                        };
                        let subs = subs.lock().unwrap();
                        for w in subs.iter() {
                            let mut w = w.lock().unwrap();
                            let _ = write_frame(&mut *w, &resp);
                        }
                        break;
                    }
                    Ok(n) => {
                        let mut chunk = carry.clone();
                        chunk.extend_from_slice(&buf[..n]);

                        let valid_up_to = match std::str::from_utf8(&chunk) {
                            Ok(_) => chunk.len(),
                            Err(e) => e.valid_up_to(),
                        };

                        if valid_up_to > 0 {
                            let valid = &chunk[..valid_up_to];
                            {
                                let mut sb = sb.lock().unwrap();
                                sb.append(valid);
                            }
                            let s = String::from_utf8_lossy(valid).into_owned();
                            let resp = Response::Output {
                                session_id: sid.clone(),
                                data: s,
                            };
                            let subs = subs.lock().unwrap();
                            for w in subs.iter() {
                                let mut w = w.lock().unwrap();
                                let _ = write_frame(&mut *w, &resp);
                            }
                        }

                        carry = chunk[valid_up_to..].to_vec();
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            master,
            writer: Some(Box::new(writer)),
            scrollback,
            subscribers,
        })
    }

    /// Write data to the PTY master.
    pub fn write(&mut self, data: &str) -> std::io::Result<()> {
        if let Some(ref mut w) = self.writer {
            w.write_all(data.as_bytes())?;
            w.flush()?;
        }
        Ok(())
    }

    /// Resize the PTY.
    pub fn resize(
        &self,
        cols: u16,
        rows: u16,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// Add a subscriber to receive output frames.
    pub fn add_subscriber(&self, writer: ClientWriter) {
        self.subscribers.lock().unwrap().push(writer);
    }

    /// Kill the session by dropping the writer (closes the PTY master).
    pub fn kill(&mut self) {
        self.writer = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollback_truncates_at_utf8_boundary() {
        let mut sb = Scrollback::new(10);
        sb.append(b"hello");
        assert_eq!(sb.len(), 5);
        sb.append(b"world!!");
        assert!(sb.len() <= 10);
        let s = sb.as_string();
        assert!(!s.starts_with('\u{FFFD}'));
    }

    #[test]
    fn find_boundary_skips_continuation_bytes() {
        let data = b"ab\xC3\xA9\xC3\xA9"; // "abéé", start midway through first é
        let boundary = find_utf8_boundary(data, 3);
        assert_eq!(boundary, 4);
    }

    #[test]
    fn scrollback_append_and_read() {
        let mut sb = Scrollback::new(100);
        sb.append(b"hello world");
        assert_eq!(sb.as_string(), "hello world");
    }
}
