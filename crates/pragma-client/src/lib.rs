//! Native Pragma client transport and frame I/O.
//!
//! This crate is the single local/remote connect seam for native clients. The
//! synchronous API talks to a Unix socket path; remote hosts are reached by an
//! SSH streamlocal bridge that exposes the forwarded remote socket as a local
//! Unix socket. PTY output stays on the raw binary frame path defined by
//! `pragma-protocol`.

#[cfg(feature = "router")]
pub mod router;
#[cfg(feature = "ssh")]
mod ssh;

#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use pragma_constants::{ProtocolErrorCode, ProtocolRpcMethod, CONSTANTS};
use pragma_protocol::{
    read_json_frame, write_input_frame, write_json_frame, AgentAnswer, AgentDecision, AgentInput,
    AgentInterrupt, AgentMessage, AgentReportPayload, ControlRequest, ProtocolEventKind,
    RequestFrame, RequestKind, RpcError, RpcRequest, ServerFrame, SubscriptionRequest,
    WorkspaceSnapshot,
};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

#[cfg(feature = "ssh")]
pub use ssh::{
    ssh_exec, start_ssh_bridge, RemoteAuth, SshBridgeConfig, SshConnectConfig, SshExecResult,
};

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
    /// The server rejected an RPC request with a protocol-level code.
    #[error("rpc error {code:?}: {message}")]
    Rpc {
        code: ProtocolErrorCode,
        message: String,
    },
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
    /// The app's bundled resource directory, forwarded to the spawned server as
    /// `PRAGMA_RESOURCE_DIR` so it can resolve staged watcher bundles for
    /// headless agent launches. `None` outside a bundled app (tests, CLI).
    resource_dir: Option<PathBuf>,
}

impl LocalServerConfig {
    /// Creates a local managed-server configuration.
    #[must_use]
    pub fn new(
        app_data_dir: PathBuf,
        channel: String,
        workspace_root: PathBuf,
        debug: bool,
        resource_dir: Option<PathBuf>,
    ) -> Self {
        Self {
            app_data_dir,
            channel,
            workspace_root,
            debug,
            resource_dir,
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

/// Cap on idle pooled request/RPC connections retained between calls.
///
/// Concurrent callers above the cap still work — they open a fresh connection
/// and it is simply dropped instead of pooled on return.
const REQUEST_POOL_MAX_IDLE: usize = 4;

/// Synchronous client for Pragma server requests and PTY streams.
#[derive(Clone)]
pub struct PragmaClient {
    endpoint: ClientEndpoint,
    launch_lock: Arc<Mutex<()>>,
    /// Idle request/RPC connections. A connection is checked out per call and
    /// returned afterwards, so concurrent RPCs (file reads, diffs, git polls)
    /// run in parallel on their own connections instead of serializing behind
    /// one shared stream — the server handles each connection on its own
    /// thread.
    request_pool: Arc<Mutex<Vec<UnixStream>>>,
    input_tx: Arc<Mutex<Option<Sender<InputMsg>>>>,
}

struct InputMsg {
    session_id: String,
    data: Vec<u8>,
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
            request_pool: Arc::new(Mutex::new(Vec::new())),
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
    /// request's success response. A `Some` size resizes the PTY to the
    /// attacher's viewport; `None` attaches as a passive observer without
    /// resizing (e.g. a plugin watcher tailing output).
    pub fn attach_stream(
        &self,
        session_id: String,
        size: Option<(u16, u16)>,
    ) -> ClientResult<UnixStream> {
        let request = request_attach(session_id, size);
        self.open_event_stream(&request)
    }

    /// Opens a snapshot-then-delta subscription and returns the event stream
    /// positioned after the request's success response. For `FileChanged`,
    /// `worktree_id` labels the deltas and `cwd` is the trusted absolute root
    /// the server watches.
    pub fn subscribe_stream(
        &self,
        event: ProtocolEventKind,
        worktree_id: Option<String>,
        cwd: Option<String>,
    ) -> ClientResult<UnixStream> {
        let request = request_subscribe(event, worktree_id, cwd);
        self.open_event_stream(&request)
    }

    /// Enqueues terminal input on a dedicated writer connection.
    pub fn write(&self, session_id: String, data: impl Into<Vec<u8>>) -> ClientResult<()> {
        let mut guard = self.input_tx.lock()?;
        if guard.is_none() {
            *guard = Some(self.start_input_writer());
        }
        let msg = InputMsg {
            session_id,
            data: data.into(),
        };
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

    /// Reports an agent status update to the server.
    pub fn report_agent(&self, payload: &AgentReportPayload) -> ClientResult<()> {
        let request = request_agent_report(payload)?;
        self.request(&request)
    }

    /// Reports one rich agent message to the server.
    pub fn report_agent_message(&self, message: &AgentMessage) -> ClientResult<()> {
        let request = request_agent_message(message)?;
        self.request(&request)
    }

    /// Publishes a command-approval verdict, fanned out to agent subscribers.
    pub fn report_agent_decision(&self, decision: &AgentDecision) -> ClientResult<()> {
        let request = request_agent_decision(decision)?;
        self.request(&request)
    }

    /// Publishes a reply to a question request, fanned out to agent subscribers.
    pub fn report_agent_answer(&self, answer: &AgentAnswer) -> ClientResult<()> {
        let request = request_agent_answer(answer)?;
        self.request(&request)
    }

    /// Publishes a free-form interjection, fanned out to agent subscribers.
    pub fn report_agent_input(&self, input: &AgentInput) -> ClientResult<()> {
        let request = request_agent_input(input)?;
        self.request(&request)
    }

    /// Publishes a transient interrupt, fanned out to agent subscribers.
    pub fn report_agent_interrupt(&self, interrupt: &AgentInterrupt) -> ClientResult<()> {
        let request = request_agent_interrupt(interrupt)?;
        self.request(&request)
    }

    /// Publishes a full workspace mirror (projects/worktrees/tabs) the server
    /// caches and broadcasts to `workspace` subscribers (e.g. a paired phone
    /// rendering the session launcher). Fire-and-forget.
    pub fn publish_workspace(&self, snapshot: &WorkspaceSnapshot) -> ClientResult<()> {
        let request = request_publish_workspace(snapshot)?;
        self.request(&request)
    }

    /// Opens a daemon-wide agent event stream positioned after the success response.
    pub fn subscribe_agents_stream(&self) -> ClientResult<UnixStream> {
        let request = request_subscribe_agents();
        self.open_event_stream(&request)
    }

    /// Reads the server's advertised protocol version from its `Hello` frame.
    ///
    /// For a socket endpoint (an SSH bridge) this just connects and reads the
    /// first frame; for a managed-local endpoint it spawns the server first.
    /// Used to verify a remote `pragma-server` matches the client's expected
    /// protocol before a project is routed to it.
    pub fn server_protocol_version(&self) -> ClientResult<u64> {
        let mut stream = match &self.endpoint {
            ClientEndpoint::Socket(path) => UnixStream::connect(path)?,
            ClientEndpoint::ManagedLocal(_) => self.connect_with_spawn()?,
        };
        configure_stream(&stream)?;
        match read_json_frame::<ServerFrame>(&mut stream)? {
            ServerFrame::Hello(hello) => Ok(hello.protocol_version),
            _ => Err(ClientError::Server(
                "server did not send a hello frame".to_string(),
            )),
        }
    }

    /// Restarts a managed local server and confirms a compatible server is up.
    pub fn restart(&self) -> ClientResult<()> {
        self.request_pool.lock()?.clear();
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
                | ServerFrame::Rpc(_)
                | ServerFrame::Control(_)
                | ServerFrame::ControlResult(_) => {}
            }
        }
    }

    fn start_input_writer(&self) -> Sender<InputMsg> {
        let (tx, rx) = mpsc::channel::<InputMsg>();
        let client = self.clone();
        thread::spawn(move || {
            let mut conn: Option<UnixStream> = None;
            while let Ok(mut msg) = rx.recv() {
                while let Ok(next) = rx.try_recv() {
                    if next.session_id == msg.session_id {
                        msg.data.extend_from_slice(&next.data);
                    } else {
                        send_input_frame(&client, &mut conn, &msg);
                        msg = next;
                    }
                }
                send_input_frame(&client, &mut conn, &msg);
            }
        });
        tx
    }

    fn request(&self, request: &RequestFrame) -> ClientResult<()> {
        self.with_request_conn("server request failed", |stream| {
            Self::request_on(stream, request)
        })
    }

    /// Sends a business-logic RPC and returns its JSON response payload.
    ///
    /// This is the single entry point for the `git`/`filesystem`/… host methods.
    /// For a remote project the same call travels the SSH streamlocal bridge and
    /// executes on the remote `pragma-server` — the caller is endpoint-agnostic.
    pub fn rpc(&self, method: ProtocolRpcMethod, payload: Value) -> ClientResult<Value> {
        let request = request_rpc(method, payload);
        self.with_request_conn("server rpc failed", |stream| {
            configure_rpc_stream(stream)?;
            let result = Self::rpc_on(stream, &request);
            configure_stream(stream)?;
            result
        })
    }

    /// Sends a brokered control request to the controller app and awaits its
    /// `ControlResult` reply. Used by the gateway to route remote
    /// `agentSessionLaunch` requests to the desktop app. Returns the
    /// controller's payload on `ok: true`; surfaces the controller error
    /// (or `app not running` server failure) as `ClientError::Server`.
    pub fn control(
        &self,
        method: pragma_protocol::ControlMethod,
        payload: Value,
    ) -> ClientResult<Value> {
        let request = request_control(method, payload);
        self.with_request_conn("server control failed", |stream| {
            // Agent launches may legitimately exceed the normal 5s request
            // timeout while the host resolves plugins or creates a worktree.
            // A timeout here is especially unsafe: transport retry duplicates
            // a control request whose first launch may still have succeeded.
            configure_rpc_stream(stream)?;
            let result = Self::control_on(stream, &request);
            configure_stream(stream)?;
            result
        })
    }

    /// Reads until the `ControlResult` matching `request.request_id` arrives.
    fn control_on(
        stream: &mut UnixStream,
        request: &RequestFrame,
    ) -> Result<ClientResult<Value>, ClientError> {
        write_json_frame(stream, request)?;
        loop {
            match read_json_frame::<ServerFrame>(stream)? {
                ServerFrame::ControlResult(result) => {
                    return Ok(if result.ok {
                        Ok(result.payload.unwrap_or(Value::Null))
                    } else {
                        Err(result.error.map_or_else(
                            || ClientError::Server("control request failed".to_string()),
                            ClientError::Server,
                        ))
                    });
                }
                ServerFrame::Hello(_)
                | ServerFrame::Response(_)
                | ServerFrame::Event(_)
                | ServerFrame::Rpc(_)
                | ServerFrame::Control(_) => {}
            }
        }
    }

    /// Runs `op` on a checked-out request connection, returning the connection
    /// to the pool on success. A transport error retries exactly once on a
    /// fresh connection (a pooled stream may be stale after a server restart);
    /// the stale pool is discarded so other callers don't retry through it too.
    fn with_request_conn<T>(
        &self,
        failure: &str,
        op: impl Fn(&mut UnixStream) -> Result<ClientResult<T>, ClientError>,
    ) -> ClientResult<T> {
        let mut last_err: Option<ClientError> = None;
        for attempt in 0..2 {
            let mut stream = if attempt == 0 {
                match self.request_pool.lock()?.pop() {
                    Some(stream) => stream,
                    None => self.connect_with_spawn()?,
                }
            } else {
                self.request_pool.lock()?.clear();
                self.connect_with_spawn()?
            };
            match op(&mut stream) {
                Ok(result) => {
                    let mut pool = self.request_pool.lock()?;
                    if pool.len() < REQUEST_POOL_MAX_IDLE {
                        pool.push(stream);
                    }
                    return result;
                }
                Err(transport_err) => {
                    last_err = Some(transport_err);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| ClientError::Server(failure.to_string())))
    }

    fn rpc_on(
        stream: &mut UnixStream,
        request: &RequestFrame,
    ) -> Result<ClientResult<Value>, ClientError> {
        write_json_frame(stream, request)?;
        loop {
            match read_json_frame::<ServerFrame>(stream)? {
                ServerFrame::Rpc(response) if response.request_id == request.request_id => {
                    return Ok(if response.ok {
                        Ok(response.payload.unwrap_or(Value::Null))
                    } else {
                        Err(response.error.map_or_else(
                            || ClientError::Server("server rpc failed".to_string()),
                            rpc_error,
                        ))
                    });
                }
                ServerFrame::Hello(_)
                | ServerFrame::Response(_)
                | ServerFrame::Event(_)
                | ServerFrame::Rpc(_)
                | ServerFrame::Control(_)
                | ServerFrame::ControlResult(_) => {}
            }
        }
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
                | ServerFrame::Rpc(_)
                | ServerFrame::Control(_)
                | ServerFrame::ControlResult(_) => {}
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
        if let Some(resource_dir) = &config.resource_dir {
            command.env("PRAGMA_RESOURCE_DIR", resource_dir);
        }
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

/// Builds an `Attach` request frame. A `Some` size resizes the PTY to the
/// attacher's viewport; `None` attaches as a passive observer without resizing.
#[must_use]
pub fn request_attach(session_id: String, size: Option<(u16, u16)>) -> RequestFrame {
    request_frame(
        RequestKind::Attach,
        Some(session_id),
        None,
        None,
        size.map(|(cols, _)| cols),
        size.map(|(_, rows)| rows),
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

/// Builds an `AgentReport` request frame.
pub fn request_agent_report(payload: &AgentReportPayload) -> ClientResult<RequestFrame> {
    let data =
        serde_json::to_string(&payload).map_err(|error| ClientError::Server(error.to_string()))?;
    Ok(request_frame(
        RequestKind::AgentReport,
        None,
        None,
        None,
        None,
        None,
        Some(data),
    ))
}

/// Builds an `AgentMessage` request frame.
pub fn request_agent_message(message: &AgentMessage) -> ClientResult<RequestFrame> {
    let data =
        serde_json::to_string(&message).map_err(|error| ClientError::Server(error.to_string()))?;
    Ok(request_frame(
        RequestKind::AgentMessage,
        None,
        None,
        None,
        None,
        None,
        Some(data),
    ))
}

/// Builds an `AgentDecision` request frame.
pub fn request_agent_decision(decision: &AgentDecision) -> ClientResult<RequestFrame> {
    let data =
        serde_json::to_string(&decision).map_err(|error| ClientError::Server(error.to_string()))?;
    Ok(request_frame(
        RequestKind::AgentDecision,
        None,
        None,
        None,
        None,
        None,
        Some(data),
    ))
}

/// Builds an `AgentAnswer` request frame.
pub fn request_agent_answer(answer: &AgentAnswer) -> ClientResult<RequestFrame> {
    let data =
        serde_json::to_string(&answer).map_err(|error| ClientError::Server(error.to_string()))?;
    Ok(request_frame(
        RequestKind::AgentAnswer,
        None,
        None,
        None,
        None,
        None,
        Some(data),
    ))
}

/// Builds an `AgentInput` request frame.
pub fn request_agent_input(input: &AgentInput) -> ClientResult<RequestFrame> {
    let data =
        serde_json::to_string(&input).map_err(|error| ClientError::Server(error.to_string()))?;
    Ok(request_frame(
        RequestKind::AgentInput,
        None,
        None,
        None,
        None,
        None,
        Some(data),
    ))
}

/// Builds an `AgentInterrupt` request frame.
pub fn request_agent_interrupt(interrupt: &AgentInterrupt) -> ClientResult<RequestFrame> {
    let data = serde_json::to_string(&interrupt)
        .map_err(|error| ClientError::Server(error.to_string()))?;
    Ok(request_frame(
        RequestKind::AgentInterrupt,
        None,
        None,
        None,
        None,
        None,
        Some(data),
    ))
}

/// Builds a `PublishWorkspace` request frame carrying a full workspace mirror.
pub fn request_publish_workspace(snapshot: &WorkspaceSnapshot) -> ClientResult<RequestFrame> {
    let data =
        serde_json::to_string(&snapshot).map_err(|error| ClientError::Server(error.to_string()))?;
    Ok(request_frame(
        RequestKind::PublishWorkspace,
        None,
        None,
        None,
        None,
        None,
        Some(data),
    ))
}

/// Builds a `Control` request frame carrying a brokered control method + payload.
#[must_use]
pub fn request_control(method: pragma_protocol::ControlMethod, payload: Value) -> RequestFrame {
    RequestFrame {
        request_id: Uuid::new_v4().to_string(),
        kind: RequestKind::Control,
        session_id: None,
        worktree_id: None,
        cwd: None,
        cols: None,
        rows: None,
        data: None,
        rpc: None,
        subscription: None,
        control: Some(ControlRequest { method, payload }),
        control_result: None,
    }
}

/// Builds a `Subscribe` request frame for a snapshot-then-delta event stream.
#[must_use]
pub fn request_subscribe(
    event: ProtocolEventKind,
    worktree_id: Option<String>,
    cwd: Option<String>,
) -> RequestFrame {
    RequestFrame {
        request_id: Uuid::new_v4().to_string(),
        kind: RequestKind::Subscribe,
        session_id: None,
        worktree_id,
        cwd,
        cols: None,
        rows: None,
        data: None,
        rpc: None,
        subscription: Some(SubscriptionRequest {
            event,
            cursor: None,
        }),
        control: None,
        control_result: None,
    }
}

/// Builds an `Rpc` request frame carrying a business-logic method and payload.
#[must_use]
pub fn request_rpc(method: ProtocolRpcMethod, payload: Value) -> RequestFrame {
    RequestFrame {
        request_id: Uuid::new_v4().to_string(),
        kind: RequestKind::Rpc,
        session_id: None,
        worktree_id: None,
        cwd: None,
        cols: None,
        rows: None,
        data: None,
        rpc: Some(RpcRequest { method, payload }),
        subscription: None,
        control: None,
        control_result: None,
    }
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
        control: None,
        control_result: None,
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

fn configure_rpc_stream(stream: &UnixStream) -> ClientResult<()> {
    // Host RPCs can legitimately outlive the normal request timeout, notably
    // when `git push` runs user-defined pre-push hooks.
    stream.set_read_timeout(None)?;
    Ok(())
}

fn send_input_frame(client: &PragmaClient, conn: &mut Option<UnixStream>, msg: &InputMsg) {
    for _ in 0..2 {
        if conn.is_none() {
            let Ok(stream) = client.connect_with_spawn() else {
                break;
            };
            let _ = stream.set_read_timeout(None);
            *conn = Some(stream);
        }
        let Some(stream) = conn.as_mut() else {
            break;
        };
        if write_input_frame(stream, &msg.session_id, &msg.data).is_ok() {
            break;
        }
        *conn = None;
    }
}

fn rpc_error(error: RpcError) -> ClientError {
    ClientError::Rpc {
        code: error.code,
        message: error.message,
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixStream;
    use std::path::Path;

    use super::{configure_rpc_stream, configure_stream, instance_data_dir, PragmaClient};

    #[test]
    fn rpc_wait_disables_and_then_restores_read_timeout() {
        let (stream, _peer) = UnixStream::pair().expect("socket pair");

        configure_stream(&stream).expect("configure request stream");
        assert!(stream.read_timeout().expect("read timeout").is_some());

        configure_rpc_stream(&stream).expect("configure rpc stream");
        assert_eq!(stream.read_timeout().expect("rpc read timeout"), None);

        configure_stream(&stream).expect("restore request stream");
        assert!(stream
            .read_timeout()
            .expect("restored read timeout")
            .is_some());
    }

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
