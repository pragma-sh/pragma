use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use pragma_constants::CONSTANTS;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const DAEMON_DETACH_FLAG: &str = "--detach";

#[derive(Clone)]
pub struct PtyClient {
    app_data_dir: PathBuf,
    launch_lock: Arc<Mutex<()>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum PtyEvent {
    Output {
        data: String,
    },
    /// Shell-emitted window title (OSC 0 / OSC 2). Stripped out of `Output`
    /// by the daemon. The frontend applies it to the tab strip only when the
    /// user has not manually renamed the tab.
    Title {
        title: String,
    },
    Exit {
        code: Option<i32>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestFrame {
    request_id: String,
    kind: String,
    session_id: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    data: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "frame", rename_all = "camelCase")]
enum ServerFrame {
    Hello(HelloFrame),
    Response(ResponseFrame),
    Event(EventFrame),
}

/// First frame the daemon sends on every connection. Lets us detect a stale
/// long-lived daemon whose protocol no longer matches this app build.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloFrame {
    protocol_version: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResponseFrame {
    request_id: String,
    ok: bool,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
enum EventFrame {
    Output {
        #[serde(rename = "sessionId")]
        _session_id: String,
        data: String,
    },
    Title {
        #[serde(rename = "sessionId")]
        _session_id: String,
        title: String,
    },
    Exit {
        #[serde(rename = "sessionId")]
        _session_id: String,
        code: Option<i32>,
    },
}

impl PtyClient {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            app_data_dir,
            launch_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn spawn(
        &self,
        session_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
        on_event: Channel<PtyEvent>,
    ) -> AppResult<()> {
        self.stream(RequestFrame::spawn(session_id, cwd, cols, rows), on_event)
    }

    pub fn attach(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
        on_event: Channel<PtyEvent>,
    ) -> AppResult<()> {
        self.stream(RequestFrame::attach(session_id, cols, rows), on_event)
    }

    pub fn write(&self, session_id: String, data: String) -> AppResult<()> {
        self.request(RequestFrame::write(session_id, data))
    }

    pub fn resize(&self, session_id: String, cols: u16, rows: u16) -> AppResult<()> {
        self.request(RequestFrame::resize(session_id, cols, rows))
    }

    pub fn kill(&self, session_id: String) -> AppResult<()> {
        self.request(RequestFrame::kill(session_id))
    }

    /// Asks the daemon to terminate every shell whose initial cwd is `path`
    /// (or lives underneath it). Used when deleting a worktree so the user's
    /// running processes don't keep an open handle to a now-removed directory.
    pub fn kill_for_cwd(&self, path: String) -> AppResult<()> {
        self.request(RequestFrame::kill_for_cwd(path))
    }

    fn stream(&self, request: RequestFrame, on_event: Channel<PtyEvent>) -> AppResult<()> {
        let mut stream = self.connect_with_spawn()?;
        write_frame(&mut stream, &request)?;
        let request_id = request.request_id.clone();
        loop {
            match read_frame::<ServerFrame>(&mut stream)? {
                ServerFrame::Response(response) if response.request_id == request_id => {
                    if !response.ok {
                        return Err(AppError::Daemon(
                            response
                                .error
                                .unwrap_or_else(|| "daemon stream request failed".to_string()),
                        ));
                    }
                    stream.set_read_timeout(None)?;
                    break;
                }
                ServerFrame::Hello(_) | ServerFrame::Response(_) | ServerFrame::Event(_) => {}
            }
        }
        thread::spawn(move || {
            while let Ok(frame) = read_frame::<ServerFrame>(&mut stream) {
                match frame {
                    ServerFrame::Event(event) => match event {
                        EventFrame::Output { data, .. } => {
                            // The frontend dropped the channel (window/tab closed);
                            // stop draining so the socket and daemon-side forwarder
                            // thread are released instead of blocking forever.
                            if on_event.send(PtyEvent::Output { data }).is_err() {
                                break;
                            }
                        }
                        EventFrame::Title { title, .. } => {
                            if on_event.send(PtyEvent::Title { title }).is_err() {
                                break;
                            }
                        }
                        EventFrame::Exit { code, .. } => {
                            let _ = on_event.send(PtyEvent::Exit { code });
                            break;
                        }
                    },
                    ServerFrame::Hello(_) | ServerFrame::Response(_) => {}
                }
            }
            let _ = stream.shutdown(Shutdown::Both);
        });
        Ok(())
    }

    fn request(&self, request: RequestFrame) -> AppResult<()> {
        let request_id = request.request_id.clone();
        let mut stream = self.connect_with_spawn()?;
        write_frame(&mut stream, &request)?;
        loop {
            match read_frame::<ServerFrame>(&mut stream)? {
                ServerFrame::Response(response) if response.request_id == request_id => {
                    return if response.ok {
                        Ok(())
                    } else {
                        Err(AppError::Daemon(
                            response
                                .error
                                .unwrap_or_else(|| "daemon request failed".to_string()),
                        ))
                    };
                }
                ServerFrame::Hello(_) | ServerFrame::Response(_) | ServerFrame::Event(_) => {}
            }
        }
    }

    fn connect_with_spawn(&self) -> AppResult<UnixStream> {
        if let Some(stream) = self.connect_compatible()? {
            return Ok(stream);
        }
        let _guard = self.launch_lock.lock()?;
        if let Some(stream) = self.connect_compatible()? {
            return Ok(stream);
        }
        self.spawn_daemon()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.connect_compatible() {
                Ok(Some(stream)) => return Ok(stream),
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(100));
                }
                Ok(None) => {
                    return Err(AppError::Daemon(
                        "daemon did not become reachable".to_string(),
                    ))
                }
                Err(err) => return Err(err),
            }
        }
    }

    /// Connects to a daemon already listening on the socket and verifies it
    /// speaks our protocol version via its hello frame. Returns the ready stream
    /// (positioned just after the hello) when compatible, or `Ok(None)` when no
    /// daemon is reachable. A reachable-but-incompatible daemon — including an
    /// old build that predates the hello and so never sends one — is killed
    /// before returning `Ok(None)` so the caller respawns a matching daemon.
    fn connect_compatible(&self) -> AppResult<Option<UnixStream>> {
        let Ok(mut stream) = UnixStream::connect(self.socket_path()) else {
            return Ok(None);
        };
        configure_stream(&stream)?;
        // The hello arrives immediately from a healthy daemon; cap the wait so a
        // stale daemon that never greets us doesn't stall startup.
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        let expected = CONSTANTS.daemon.protocol_version.get();
        match read_frame::<ServerFrame>(&mut stream) {
            Ok(ServerFrame::Hello(hello)) if hello.protocol_version == expected => {
                configure_stream(&stream)?;
                Ok(Some(stream))
            }
            _ => {
                self.kill_stale_daemon();
                Ok(None)
            }
        }
    }

    /// Terminates a daemon whose protocol no longer matches this build. Uses the
    /// PID the daemon records in its lock file for a precise kill, falling back
    /// to `pkill` for older daemons that predate the pidfile. Removes the stale
    /// socket so the next spawn binds cleanly.
    fn kill_stale_daemon(&self) {
        let killed_by_pid = std::fs::read_to_string(self.lock_path())
            .ok()
            .and_then(|contents| contents.trim().parse::<u32>().ok())
            .is_some_and(|pid| {
                Command::new("kill")
                    .arg("-KILL")
                    .arg(pid.to_string())
                    .status()
                    .is_ok_and(|status| status.success())
            });
        if !killed_by_pid {
            // Pre-handshake daemons left no usable pidfile; match by command line.
            let _ = Command::new("pkill")
                .args(["-KILL", "-f", "pragma-daemon"])
                .status();
        }
        // Let the OS reap the process and release the socket before respawning.
        thread::sleep(Duration::from_millis(200));
        let _ = std::fs::remove_file(self.socket_path());
        let _ = std::fs::remove_file(self.lock_path());
    }

    fn lock_path(&self) -> PathBuf {
        self.socket_path().with_file_name("daemon.lock")
    }

    fn socket_path(&self) -> PathBuf {
        if cfg!(target_os = "linux") {
            std::env::var_os("XDG_RUNTIME_DIR").map_or_else(
                || self.app_data_dir.join("daemon.sock"),
                |dir| PathBuf::from(dir).join("pragma/daemon.sock"),
            )
        } else {
            self.app_data_dir.join("daemon.sock")
        }
    }

    fn spawn_daemon(&self) -> AppResult<()> {
        std::fs::create_dir_all(&self.app_data_dir)?;
        let mut command = if cfg!(debug_assertions) {
            let mut command = Command::new(cargo_executable());
            command.args(["run", "-p", "pragma-daemon", "--", DAEMON_DETACH_FLAG]);
            command.current_dir(workspace_root());
            command
        } else {
            let mut command = Command::new(daemon_executable());
            command.arg(DAEMON_DETACH_FLAG);
            command
        };
        command
            .env("PRAGMA_APP_DATA_DIR", &self.app_data_dir)
            .stdin(Stdio::null());
        if let Ok(log_file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.app_data_dir.join("daemon.log"))
        {
            if let Ok(stderr) = log_file.try_clone() {
                command.stdout(log_file).stderr(stderr);
            }
        } else {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        let mut child = command.spawn()?;
        thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}

impl RequestFrame {
    fn spawn(session_id: String, cwd: String, cols: u16, rows: u16) -> Self {
        Self::new(
            "spawn",
            Some(session_id),
            Some(cwd),
            Some(cols),
            Some(rows),
            None,
        )
    }

    fn attach(session_id: String, cols: u16, rows: u16) -> Self {
        Self::new(
            "attach",
            Some(session_id),
            None,
            Some(cols),
            Some(rows),
            None,
        )
    }

    fn write(session_id: String, data: String) -> Self {
        Self::new("write", Some(session_id), None, None, None, Some(data))
    }

    fn resize(session_id: String, cols: u16, rows: u16) -> Self {
        Self::new(
            "resize",
            Some(session_id),
            None,
            Some(cols),
            Some(rows),
            None,
        )
    }

    fn kill(session_id: String) -> Self {
        Self::new("kill", Some(session_id), None, None, None, None)
    }

    fn kill_for_cwd(cwd: String) -> Self {
        Self::new("killForCwd", None, None, None, None, Some(cwd))
    }

    fn new(
        kind: &str,
        session_id: Option<String>,
        cwd: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
        data: Option<String>,
    ) -> Self {
        Self {
            request_id: Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            session_id,
            cwd,
            cols,
            rows,
            data,
        }
    }
}

fn daemon_executable() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .map_or_else(
            || PathBuf::from("pragma-daemon"),
            |dir| dir.join("pragma-daemon"),
        )
}

fn cargo_executable() -> PathBuf {
    if let Some(cargo) = option_env!("CARGO") {
        return PathBuf::from(cargo);
    }
    if let Some(home) = std::env::var_os("HOME") {
        let cargo = PathBuf::from(home).join(".cargo/bin/cargo");
        if cargo.is_file() {
            return cargo;
        }
    }
    for candidate in [
        "/opt/homebrew/bin/cargo",
        "/usr/local/bin/cargo",
        "/usr/bin/cargo",
    ] {
        let cargo = PathBuf::from(candidate);
        if cargo.is_file() {
            return cargo;
        }
    }
    PathBuf::from("cargo")
}

fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is `<root>/apps/pragma/src-tauri`; the workspace root is
    // three ancestors up (src-tauri -> pragma -> apps -> <root>).
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

fn configure_stream(stream: &UnixStream) -> AppResult<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    Ok(())
}

fn read_frame<T: for<'de> Deserialize<'de>>(reader: &mut impl Read) -> AppResult<T> {
    let mut len_bytes = [0_u8; 4];
    reader.read_exact(&mut len_bytes)?;
    let len = u32::from_be_bytes(len_bytes) as usize;
    // Bound the allocation so a malformed/oversized length can't OOM the app.
    // Mirrors the 16 MiB cap the daemon enforces in `protocol::read_frame`.
    if len > 16 * 1024 * 1024 {
        return Err(AppError::Daemon("daemon frame is too large".to_string()));
    }
    let mut bytes = vec![0_u8; len];
    reader.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(AppError::from)
}

fn write_frame<T: Serialize>(writer: &mut impl Write, frame: &T) -> AppResult<()> {
    let bytes = serde_json::to_vec(frame)?;
    let len = u32::try_from(bytes.len())
        .map_err(|_| AppError::Daemon("frame is too large".to_string()))?;
    writer.write_all(&len.to_be_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}
