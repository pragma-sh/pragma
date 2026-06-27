//! Native Pragma client transport and frame I/O.
//!
//! This crate is the single local/remote connect seam for native clients. The
//! synchronous API talks to a Unix socket path; remote hosts are reached by an
//! SSH streamlocal bridge that exposes the forwarded remote socket as a local
//! Unix socket. PTY output stays on the raw binary frame path defined by
//! `pragma-protocol`.

pub mod router;
mod ssh;

use std::net::Shutdown;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use pragma_constants::CONSTANTS;
use pragma_protocol::{
    read_frame, read_json_frame, write_json_frame, RequestFrame, RequestKind, ServerFrame,
};
use thiserror::Error;
use uuid::Uuid;

pub use ssh::{start_ssh_bridge, RemoteAuth, SshBridgeConfig};

const SERVER_DETACH_FLAG: &str = "--detach";
const SERVER_SOCKET_FILE: &str = "daemon.sock";
const SERVER_LOCK_FILE: &str = "server.lock";
const SERVER_LOG_FILE: &str = "server.log";

/// Result type for Pragma client operations.
pub type ClientResult<T> = Result<T, ClientError>;

/// Errors returned by the native client transport layer.
#[derive(Debug, Error)]
pub enum ClientError {
    /// Local I/O failed.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// The daemon/server frame codec failed.
    #[error("protocol error: {0}")]
    Protocol(#[from] pragma_protocol::ProtocolError),
    /// The server rejected a request.
    #[error("server error: {0}")]
    Server(String),
    /// A mutex protecting shared client state was poisoned.
    #[error("lock poisoned")]
    LockPoisoned,
    /// This endpoint cannot be auto-started by the local client.
    #[error("server is not reachable and this endpoint has no local bootstrap")]
    NoBootstrap,
}

impl<T> From<PoisonError<T>> for ClientError {
    fn from(_: PoisonError<T>) -> Self {
        Self::LockPoisoned
    }
}

/// Managed local server configuration used by the desktop app today.
#[derive(Clone, Debug)]
pub struct LocalServerConfig {
    app_data_dir: PathBuf,
    channel: String,
    workspace_root: PathBuf,
    debug: bool,
}

impl LocalServerConfig {
    /// Creates a local managed-server configuration.
    #[must_use]
    pub fn new(
        app_data_dir: PathBuf,
        channel: String,
        workspace_root: PathBuf,
        debug: bool,
    ) -> Self {
        Self {
            app_data_dir,
            channel,
            workspace_root,
            debug,
        }
    }
}

/// The endpoint a native client connects to.
#[derive(Clone, Debug)]
pub enum ClientEndpoint {
    /// A local `pragma-server` process that this client may spawn and replace.
    ManagedLocal(LocalServerConfig),
    /// An already-available Unix socket, usually an SSH streamlocal bridge.
    Socket(PathBuf),
}

/// Synchronous client for Pragma server requests and PTY streams.
#[derive(Clone)]
pub struct PragmaClient {
    endpoint: ClientEndpoint,
    launch_lock: Arc<Mutex<()>>,
    request_conn: Arc<Mutex<Option<UnixStream>>>,
    input_tx: Arc<Mutex<Option<Sender<InputMsg>>>>,
}

struct InputMsg {
    session_id: String,
    data: String,
}

impl PragmaClient {
    /// Creates a client that owns bootstrap of a local `pragma-server`.
    #[must_use]
    pub fn new_local(config: LocalServerConfig) -> Self {
        Self::new(ClientEndpoint::ManagedLocal(config))
    }

    /// Creates a client over an already-listening Unix socket.
    #[must_use]
    pub fn new_socket(socket_path: PathBuf) -> Self {
        Self::new(ClientEndpoint::Socket(socket_path))
    }

    fn new(endpoint: ClientEndpoint) -> Self {
        Self {
            endpoint,
            launch_lock: Arc::new(Mutex::new(())),
            request_conn: Arc::new(Mutex::new(None)),
            input_tx: Arc::new(Mutex::new(None)),
        }
    }

    /// Opens a spawn request and returns the event stream positioned after the
    /// request's success response.
    pub fn spawn_stream(
        &self,
        session_id: String,
        worktree_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> ClientResult<UnixStream> {
        let request = request_spawn(session_id, worktree_id, cwd, cols, rows);
        self.open_event_stream(&request)
    }

    /// Opens an attach request and returns the event stream positioned after the
    /// request's success response.
    pub fn attach_stream(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
    ) -> ClientResult<UnixStream> {
        let request = request_attach(session_id, cols, rows);
        self.open_event_stream(&request)
    }

    /// Enqueues terminal input on a dedicated writer connection.
    pub fn write(&self, session_id: String, data: String) -> ClientResult<()> {
        let mut guard = self.input_tx.lock()?;
        if guard.is_none() {
            *guard = Some(self.start_input_writer());
        }
        let msg = InputMsg { session_id, data };
        if let Err(err) = guard.as_ref().expect("input writer present").send(msg) {
            let tx = self.start_input_writer();
            let _ = tx.send(err.0);
            *guard = Some(tx);
        }
        Ok(())
    }

    /// Resizes a server-owned PTY session.
    pub fn resize(&self, session_id: String, cols: u16, rows: u16) -> ClientResult<()> {
        let request = request_resize(session_id, cols, rows);
        self.request(&request)
    }

    /// Kills a server-owned PTY session.
    pub fn kill(&self, session_id: String) -> ClientResult<()> {
        let request = request_kill(session_id);
        self.request(&request)
    }

    /// Kills every PTY whose initial cwd is `path` or under it.
    pub fn kill_for_cwd(&self, path: String) -> ClientResult<()> {
        let request = request_kill_for_cwd(path);
        self.request(&request)
    }

    /// Marks a tab's completed agent statuses as seen.
    pub fn mark_agents_seen(&self, tab_id: String) -> ClientResult<()> {
        let request = request_mark_agents_seen(tab_id);
        self.request(&request)
    }

    /// Restarts a managed local server and confirms a compatible server is up.
    pub fn restart(&self) -> ClientResult<()> {
        *self.request_conn.lock()? = None;
        *self.input_tx.lock()? = None;
        {
            let _guard = self.launch_lock.lock()?;
            self.kill_stale_server();
            self.spawn_server()?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.connect_compatible() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
                Ok(None) => {
                    return Err(ClientError::Server(
                        "server did not become reachable after restart".to_string(),
                    ))
                }
                Err(err) => return Err(err),
            }
        }
    }

    /// Reads the server log, returning an empty string if it has not been created.
    pub fn read_log(&self) -> ClientResult<String> {
        match std::fs::read_to_string(self.log_path()) {
            Ok(contents) => Ok(contents),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(err) => Err(ClientError::from(err)),
        }
    }

    /// Connects to a compatible server, spawning a managed local server if needed.
    pub fn connect_with_spawn(&self) -> ClientResult<UnixStream> {
        if let Some(stream) = self.connect_compatible()? {
            return Ok(stream);
        }
        let _guard = self.launch_lock.lock()?;
        if let Some(stream) = self.connect_compatible()? {
            return Ok(stream);
        }
        self.spawn_server()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.connect_compatible() {
                Ok(Some(stream)) => return Ok(stream),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
                Ok(None) => {
                    return Err(ClientError::Server(
                        "server did not become reachable".to_string(),
                    ))
                }
                Err(err) => return Err(err),
            }
        }
    }

    /// Returns the Unix socket path used by this client.
    #[must_use]
    pub fn socket_path(&self) -> PathBuf {
        match &self.endpoint {
            ClientEndpoint::ManagedLocal(config) => server_dir(config).join(SERVER_SOCKET_FILE),
            ClientEndpoint::Socket(path) => path.clone(),
        }
    }

    /// Returns the server lock path beside the socket.
    #[must_use]
    pub fn lock_path(&self) -> PathBuf {
        self.socket_path().with_file_name(SERVER_LOCK_FILE)
    }

    /// Returns the server log path beside the socket.
    #[must_use]
    pub fn log_path(&self) -> PathBuf {
        self.socket_path().with_file_name(SERVER_LOG_FILE)
    }

    fn open_event_stream(&self, request: &RequestFrame) -> ClientResult<UnixStream> {
        let mut stream = self.connect_with_spawn()?;
        write_json_frame(&mut stream, request)?;
        let request_id = request.request_id.clone();
        loop {
            match read_json_frame::<ServerFrame>(&mut stream)? {
                ServerFrame::Response(response) if response.request_id == request_id => {
                    if !response.ok {
                        return Err(ClientError::Server(
                            response
                                .error
                                .unwrap_or_else(|| "server stream request failed".to_string()),
                        ));
                    }
                    stream.set_read_timeout(None)?;
                    return Ok(stream);
                }
                ServerFrame::Hello(_)
                | ServerFrame::Response(_)
                | ServerFrame::Event(_)
                | ServerFrame::Rpc(_) => {}
            }
        }
    }

    fn start_input_writer(&self) -> Sender<InputMsg> {
        let (tx, rx) = mpsc::channel::<InputMsg>();
        let client = self.clone();
        thread::spawn(move || {
            let mut conn: Option<UnixStream> = None;
            for msg in rx {
                let frame = request_write(msg.session_id, msg.data);
                for _ in 0..2 {
                    if conn.is_none() {
                        let Ok(stream) = client.connect_with_spawn() else {
                            break;
                        };
                        let _ = stream.set_read_timeout(None);
                        if let Ok(reader) = stream.try_clone() {
                            thread::spawn(move || discard_frames(reader));
                        }
                        conn = Some(stream);
                    }
                    let Some(stream) = conn.as_mut() else {
                        break;
                    };
                    if write_json_frame(stream, &frame).is_ok() {
                        break;
                    }
                    conn = None;
                }
            }
        });
        tx
    }

    fn request(&self, request: &RequestFrame) -> ClientResult<()> {
        let mut guard = self.request_conn.lock()?;
        let mut last_err: Option<ClientError> = None;
        for _ in 0..2 {
            if guard.is_none() {
                *guard = Some(self.connect_with_spawn()?);
            }
            let stream = guard.as_mut().expect("connection just established");
            match Self::request_on(stream, request) {
                Ok(result) => return result,
                Err(transport_err) => {
                    *guard = None;
                    last_err = Some(transport_err);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| ClientError::Server("server request failed".to_string())))
    }

    fn request_on(
        stream: &mut UnixStream,
        request: &RequestFrame,
    ) -> Result<ClientResult<()>, ClientError> {
        write_json_frame(stream, request)?;
        loop {
            match read_json_frame::<ServerFrame>(stream)? {
                ServerFrame::Response(response) if response.request_id == request.request_id => {
                    return Ok(if response.ok {
                        Ok(())
                    } else {
                        Err(ClientError::Server(
                            response
                                .error
                                .unwrap_or_else(|| "server request failed".to_string()),
                        ))
                    });
                }
                ServerFrame::Hello(_)
                | ServerFrame::Response(_)
                | ServerFrame::Event(_)
                | ServerFrame::Rpc(_) => {}
            }
        }
    }

    fn connect_compatible(&self) -> ClientResult<Option<UnixStream>> {
        let Ok(mut stream) = UnixStream::connect(self.socket_path()) else {
            return Ok(None);
        };
        configure_stream(&stream)?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        let expected = CONSTANTS.daemon.protocol_version.get();
        match read_json_frame::<ServerFrame>(&mut stream) {
            Ok(ServerFrame::Hello(hello)) if hello.protocol_version == expected => {
                configure_stream(&stream)?;
                Ok(Some(stream))
            }
            _ => {
                self.kill_stale_server();
                Ok(None)
            }
        }
    }

    fn kill_stale_server(&self) {
        if !matches!(self.endpoint, ClientEndpoint::ManagedLocal(_)) {
            return;
        }
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
            let _ = Command::new("pkill")
                .args(["-KILL", "-f", "pragma-server"])
                .status();
            let _ = Command::new("pkill")
                .args(["-KILL", "-f", "pragma-daemon"])
                .status();
        }
        thread::sleep(Duration::from_millis(200));
        let _ = std::fs::remove_file(self.socket_path());
        let _ = std::fs::remove_file(self.lock_path());
    }

    fn spawn_server(&self) -> ClientResult<()> {
        let ClientEndpoint::ManagedLocal(config) = &self.endpoint else {
            return Err(ClientError::NoBootstrap);
        };
        std::fs::create_dir_all(&config.app_data_dir)?;
        if let Some(parent) = self.log_path().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut command = if config.debug {
            let mut command = Command::new(cargo_executable());
            command.args(["run", "-p", "pragma-server", "--", SERVER_DETACH_FLAG]);
            command.current_dir(&config.workspace_root);
            command
        } else {
            let mut command = Command::new(sidecar_executable("pragma-server"));
            command.arg(SERVER_DETACH_FLAG);
            command
        };
        command
            .env("PRAGMA_APP_DATA_DIR", &config.app_data_dir)
            .env("PRAGMA_DAEMON_CHANNEL", &config.channel)
            .env("PRAGMA_SERVER_CHANNEL", &config.channel)
            .stdin(Stdio::null());
        if let Ok(log_file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log_path())
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

/// Resolves the isolation channel for an app product name.
#[must_use]
pub fn instance_channel(product_name: Option<&str>, workspace_root: &Path) -> String {
    if product_name.is_some_and(|name| name.contains("Dev")) {
        pragma_protocol::dev_channel(workspace_root)
    } else {
        pragma_protocol::PROD_CHANNEL.to_string()
    }
}

/// Resolves the per-instance client-local data directory for a channel.
#[must_use]
pub fn instance_data_dir(app_data_dir: &Path, channel: &str) -> PathBuf {
    if channel == pragma_protocol::PROD_CHANNEL {
        app_data_dir.to_path_buf()
    } else {
        app_data_dir.join(channel)
    }
}

/// Resolves a sidecar executable path beside the current native client binary.
#[must_use]
pub fn sidecar_executable(name: &str) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .map_or_else(|| PathBuf::from(name), |dir| dir.join(name))
}

/// Resolves the cargo executable used by debug builds to spawn server/CLI crates.
#[must_use]
pub fn cargo_executable() -> PathBuf {
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

/// Builds a `Spawn` request frame.
#[must_use]
pub fn request_spawn(
    session_id: String,
    worktree_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> RequestFrame {
    request_frame(
        RequestKind::Spawn,
        Some(session_id),
        Some(worktree_id),
        Some(cwd),
        Some(cols),
        Some(rows),
        None,
    )
}

/// Builds an `Attach` request frame.
#[must_use]
pub fn request_attach(session_id: String, cols: u16, rows: u16) -> RequestFrame {
    request_frame(
        RequestKind::Attach,
        Some(session_id),
        None,
        None,
        Some(cols),
        Some(rows),
        None,
    )
}

/// Builds a `Write` request frame.
#[must_use]
pub fn request_write(session_id: String, data: String) -> RequestFrame {
    request_frame(
        RequestKind::Write,
        Some(session_id),
        None,
        None,
        None,
        None,
        Some(data),
    )
}

/// Builds a `Resize` request frame.
#[must_use]
pub fn request_resize(session_id: String, cols: u16, rows: u16) -> RequestFrame {
    request_frame(
        RequestKind::Resize,
        Some(session_id),
        None,
        None,
        Some(cols),
        Some(rows),
        None,
    )
}

/// Builds a `Kill` request frame.
#[must_use]
pub fn request_kill(session_id: String) -> RequestFrame {
    request_frame(
        RequestKind::Kill,
        Some(session_id),
        None,
        None,
        None,
        None,
        None,
    )
}

/// Builds a `KillForCwd` request frame.
#[must_use]
pub fn request_kill_for_cwd(cwd: String) -> RequestFrame {
    request_frame(
        RequestKind::KillForCwd,
        None,
        None,
        None,
        None,
        None,
        Some(cwd),
    )
}

/// Builds a `MarkAgentsSeen` request frame.
#[must_use]
pub fn request_mark_agents_seen(tab_id: String) -> RequestFrame {
    request_frame(
        RequestKind::MarkAgentsSeen,
        Some(tab_id),
        None,
        None,
        None,
        None,
        None,
    )
}

/// Builds a `SubscribeAgents` request frame.
#[must_use]
pub fn request_subscribe_agents() -> RequestFrame {
    request_frame(
        RequestKind::SubscribeAgents,
        None,
        None,
        None,
        None,
        None,
        None,
    )
}

fn request_frame(
    kind: RequestKind,
    session_id: Option<String>,
    worktree_id: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    data: Option<String>,
) -> RequestFrame {
    RequestFrame {
        request_id: Uuid::new_v4().to_string(),
        kind,
        session_id,
        worktree_id,
        cwd,
        cols,
        rows,
        data,
        rpc: None,
        subscription: None,
    }
}

fn server_dir(config: &LocalServerConfig) -> PathBuf {
    if cfg!(target_os = "linux") {
        std::env::var_os("XDG_RUNTIME_DIR").map_or_else(
            || config.app_data_dir.join(&config.channel),
            |dir| PathBuf::from(dir).join(&config.channel),
        )
    } else {
        config.app_data_dir.join(&config.channel)
    }
}

fn configure_stream(stream: &UnixStream) -> ClientResult<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    Ok(())
}

fn discard_frames(mut reader: UnixStream) {
    while read_frame(&mut reader).is_ok() {}
    let _ = reader.shutdown(Shutdown::Both);
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{instance_data_dir, PragmaClient};

    #[test]
    fn log_path_sits_beside_socket() {
        let client =
            PragmaClient::new_socket(std::path::PathBuf::from("/tmp/pragma-test/daemon.sock"));
        let socket = client.socket_path();
        let log = client.log_path();
        assert_eq!(log.parent(), socket.parent());
        assert_eq!(log.file_name().and_then(|n| n.to_str()), Some("server.log"));
    }

    #[test]
    fn socket_endpoint_paths_are_beside_the_socket() {
        let client =
            PragmaClient::new_socket(std::path::PathBuf::from("/tmp/pragma-test/bridge.sock"));
        assert_eq!(
            client.lock_path().file_name().and_then(|n| n.to_str()),
            Some("server.lock"),
        );
    }

    #[test]
    fn data_dir_isolates_dev_but_preserves_prod() {
        let base = Path::new("/tmp/pragma-test");
        assert_eq!(instance_data_dir(base, "pragma"), base);
        assert_eq!(
            instance_data_dir(base, "pragma-dev-abc123"),
            base.join("pragma-dev-abc123"),
        );
    }
}
