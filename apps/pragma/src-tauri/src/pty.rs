use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::ipc::Channel;

use pragma_daemon::protocol::{read_response, Request, Response};

use crate::error::AppError;

const MAX_CONNECT_RETRIES: u32 = 20;
const RETRY_DELAY_MS: u64 = 150;

/// Manages communication with the `pragma-daemon` process.
///
/// Each `spawn`/`attach` opens a dedicated Unix socket connection so the
/// per-session reader thread never contends with command requests.
/// `write`/`resize`/`kill` use a shared connection for simple request-response.
pub struct DaemonClient {
    socket_path: String,
    cmd_stream: Mutex<Option<UnixStream>>,
}

impl DaemonClient {
    pub fn new(socket_path: String) -> Self {
        Self {
            socket_path,
            cmd_stream: Mutex::new(None),
        }
    }

    fn socket_dir(&self) -> PathBuf {
        let p = PathBuf::from(&self.socket_path);
        p.parent().unwrap_or(&p).to_path_buf()
    }

    /// Open a new connection to the daemon, launching it if needed.
    fn connect(&self) -> Result<UnixStream, AppError> {
        for i in 0..MAX_CONNECT_RETRIES {
            if let Ok(s) = UnixStream::connect(&self.socket_path) {
                return Ok(s);
            } else {
                if i == 0 {
                    self.launch_daemon()?;
                }
                thread::sleep(Duration::from_millis(RETRY_DELAY_MS));
            }
        }
        Err(AppError::Daemon("failed to connect to daemon".into()))
    }

    /// Get or create the shared command stream.
    fn cmd_stream(&self) -> Result<std::sync::MutexGuard<'_, Option<UnixStream>>, AppError> {
        let mut guard = self.cmd_stream.lock().unwrap();
        if guard.is_none() {
            *guard = Some(self.connect()?);
        }
        Ok(guard)
    }

    #[allow(unsafe_code)]
    fn launch_daemon(&self) -> Result<(), AppError> {
        let socket_dir = self.socket_dir();
        std::fs::create_dir_all(&socket_dir)?;

        let daemon_path = self
            .find_daemon_binary()
            .ok_or_else(|| AppError::Daemon("daemon binary not found".into()))?;

        let log_path = socket_dir.join("daemon.log");
        let log_file = std::fs::File::create(&log_path)
            .unwrap_or_else(|_| std::fs::File::create("/dev/null").unwrap());

        let mut cmd = std::process::Command::new(&daemon_path);
        cmd.arg(&self.socket_path);
        cmd.stdout(std::process::Stdio::from(log_file.try_clone().unwrap()));
        cmd.stderr(std::process::Stdio::from(log_file));

        // Creates a new process group so the daemon survives app close.
        // Required for detach semantics — the only unsafe in the crate.
        unsafe {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        cmd.spawn()
            .map_err(|e| AppError::Daemon(format!("failed to launch daemon: {e}")))?;

        Ok(())
    }

    fn find_daemon_binary(&self) -> Option<PathBuf> {
        let candidates = [
            std::env::current_exe()
                .ok()?
                .parent()?
                .join("pragma-daemon"),
            std::env::current_exe()
                .ok()?
                .parent()?
                .join("../../../target/debug/pragma-daemon"),
            std::env::current_exe()
                .ok()?
                .parent()?
                .join("../../../target/release/pragma-daemon"),
        ];
        candidates.into_iter().find(|p| p.exists())
    }

    /// Frame and write a request without reading a response. Used by streaming
    /// commands (`spawn`/`attach`) whose responses are demuxed by a reader
    /// thread so no frame — scrollback, error, or output — is ever dropped.
    fn write_request(stream: &mut UnixStream, req: &Request) -> Result<(), AppError> {
        let json =
            serde_json::to_string(req).map_err(|e| AppError::Daemon(format!("serialize: {e}")))?;
        let len = json.len() as u32;
        stream
            .write_all(&len.to_be_bytes())
            .map_err(|e| AppError::Daemon(format!("write: {e}")))?;
        stream
            .write_all(json.as_bytes())
            .map_err(|e| AppError::Daemon(format!("write: {e}")))?;
        stream
            .flush()
            .map_err(|e| AppError::Daemon(format!("flush: {e}")))?;
        Ok(())
    }

    /// Send a request on the given stream and read the immediate response.
    /// Used by the simple request-response commands (`write`/`resize`/`kill`).
    fn send_request(stream: &mut UnixStream, req: &Request) -> Result<Response, AppError> {
        Self::write_request(stream, req)?;
        read_response(stream).map_err(|e| AppError::Daemon(format!("read: {e}")))
    }

    /// Spawn the reader thread that demuxes daemon frames onto the channel.
    fn spawn_reader(mut reader: UnixStream, on_event: Channel<serde_json::Value>) {
        thread::spawn(move || loop {
            match read_response(&mut reader) {
                // `Ok` is just an ack for spawn/attach — keep reading.
                Ok(Response::Ok) => {}
                // Replayed scrollback (on attach) is written like ordinary output.
                Ok(Response::Output { data, .. } | Response::Scrollback { data, .. }) => {
                    let _ = on_event.send(serde_json::json!({"type": "output", "data": data}));
                }
                Ok(Response::Exit { code, .. }) => {
                    let _ = on_event.send(serde_json::json!({"type": "exit", "code": code}));
                    break;
                }
                Ok(Response::Error { message }) => {
                    let _ = on_event.send(serde_json::json!({"type": "error", "message": message}));
                    break;
                }
                Err(_) => break,
            }
        });
    }

    /// Spawn a new PTY session. Opens a dedicated connection and starts a reader
    /// thread that forwards output/exit frames to the Tauri channel.
    pub fn spawn(
        &self,
        session_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
        on_event: Channel<serde_json::Value>,
    ) -> Result<(), AppError> {
        let mut stream = self.connect()?;

        let req = Request::Spawn {
            session_id,
            cwd,
            cols,
            rows,
        };

        Self::write_request(&mut stream, &req)?;

        let reader = stream
            .try_clone()
            .map_err(|e| AppError::Daemon(format!("clone: {e}")))?;

        Self::spawn_reader(reader, on_event);

        Ok(())
    }

    /// Attach to an existing PTY session with scrollback replay.
    pub fn attach(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
        on_event: Channel<serde_json::Value>,
    ) -> Result<(), AppError> {
        let mut stream = self.connect()?;

        let req = Request::Attach {
            session_id,
            cols,
            rows,
        };

        Self::write_request(&mut stream, &req)?;

        let reader = stream
            .try_clone()
            .map_err(|e| AppError::Daemon(format!("clone: {e}")))?;

        Self::spawn_reader(reader, on_event);

        Ok(())
    }

    /// Write data to a session.
    pub fn write(&self, session_id: &str, data: &str) -> Result<(), AppError> {
        let mut guard = self.cmd_stream()?;
        let stream = guard.as_mut().unwrap();
        let req = Request::Write {
            session_id: session_id.to_string(),
            data: data.to_string(),
        };
        match Self::send_request(stream, &req)? {
            Response::Ok => Ok(()),
            Response::Error { message } => Err(AppError::Daemon(message)),
            _ => Ok(()),
        }
    }

    /// Resize a session.
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), AppError> {
        let mut guard = self.cmd_stream()?;
        let stream = guard.as_mut().unwrap();
        let req = Request::Resize {
            session_id: session_id.to_string(),
            cols,
            rows,
        };
        match Self::send_request(stream, &req)? {
            Response::Ok => Ok(()),
            Response::Error { message } => Err(AppError::Daemon(message)),
            _ => Ok(()),
        }
    }

    /// Kill a session.
    pub fn kill(&self, session_id: &str) -> Result<(), AppError> {
        let mut guard = self.cmd_stream()?;
        let stream = guard.as_mut().unwrap();
        let req = Request::Kill {
            session_id: session_id.to_string(),
        };
        match Self::send_request(stream, &req)? {
            Response::Ok => Ok(()),
            Response::Error { message } => Err(AppError::Daemon(message)),
            _ => Ok(()),
        }
    }

    /// Release the shared connection (called on app exit).
    pub fn detach(&self) {
        let mut guard = self.cmd_stream.lock().unwrap();
        *guard = None;
    }
}
