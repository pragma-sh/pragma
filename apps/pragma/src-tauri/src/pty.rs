use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use pragma_client::request_spawn;
use pragma_client::{ClientError, LocalServerConfig, PragmaClient};
use pragma_constants::CONSTANTS;
use pragma_protocol::{
    read_frame, read_json_frame, write_json_frame, EventFrame, Frame, ProtocolEventKind,
    ServerFrame,
};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::error::{AppError, AppResult};

const GATEWAY_READY_TIMEOUT: Duration = Duration::from_secs(5);
const GATEWAY_READY_POLL: Duration = Duration::from_millis(100);

/// Live per-session event-stream connections, tracked so a disposed or
/// re-attached terminal can have its Rust-side `UnixStream` shut down
/// explicitly rather than relying on the server to notice.
///
/// Without this, a connection abandoned without an explicit kill (a dev HMR
/// reload, the webview sleeping/reloading, an SSH bridge reconnect) leaves
/// its `forward_stream` reader thread — and the matching server-side thread +
/// fd — blocked forever: the server only releases a connection when the
/// client closes its end, and nothing here ever did.
type SessionStreams = Arc<Mutex<HashMap<String, UnixStream>>>;

/// Tauri-facing PTY adapter. Transport, bootstrap, and frame request logic live
/// in `pragma-client`; this wrapper only bridges raw server frames to the
/// webview channel shape expected by the frontend.
#[derive(Clone)]
pub struct PtyClient {
    inner: PragmaClient,
    session_streams: SessionStreams,
}

/// Control events forwarded to the webview as JSON over the PTY channel.
///
/// Terminal output is sent as raw `InvokeResponseBody::Raw` so xterm receives the
/// bytes without JSON escaping or UTF-8 decoding.
#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum PtyEvent {
    /// Shell-emitted OSC title.
    Title { title: String },
    /// PTY process exit status.
    Exit { code: Option<i32> },
}

impl PtyEvent {
    fn into_body(self) -> Option<InvokeResponseBody> {
        serde_json::to_string(&self)
            .ok()
            .map(InvokeResponseBody::Json)
    }
}

impl PtyClient {
    /// Builds a managed-local client for this app instance channel.
    pub fn new(app_data_dir: PathBuf, channel: String) -> Self {
        Self {
            inner: PragmaClient::new_local(LocalServerConfig::new(
                app_data_dir,
                channel,
                workspace_root(),
                cfg!(debug_assertions),
            )),
            session_streams: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Builds a client over an already-listening Unix socket — the local end of
    /// an SSH streamlocal bridge to a remote `pragma-server`. Unlike the
    /// managed-local client, this never spawns or replaces the server.
    pub fn new_socket(socket_path: PathBuf) -> Self {
        Self {
            inner: PragmaClient::new_socket(socket_path),
            session_streams: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Records `stream` as the live event-stream connection for `session_id`,
    /// shutting down and replacing whatever connection was previously tracked
    /// for it. A prior connection here means the client re-attached (or
    /// re-spawned) without ever disposing the old one — the exact leak this
    /// tracking exists to close.
    fn track_stream(&self, session_id: &str, stream: &UnixStream) {
        let Ok(cloned) = stream.try_clone() else {
            return;
        };
        let previous = self
            .session_streams
            .lock()
            .ok()
            .and_then(|mut streams| streams.insert(session_id.to_string(), cloned));
        if let Some(previous) = previous {
            let _ = previous.shutdown(Shutdown::Both);
        }
    }

    /// Shuts down and forgets the tracked event-stream connection for
    /// `session_id`, if any. Called on dispose/kill so the connection closes
    /// immediately instead of waiting on the server to notice.
    fn close_stream(&self, session_id: &str) {
        let removed = self
            .session_streams
            .lock()
            .ok()
            .and_then(|mut streams| streams.remove(session_id));
        if let Some(stream) = removed {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }

    pub fn spawn(
        &self,
        session_id: String,
        worktree_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
        on_event: Channel<InvokeResponseBody>,
    ) -> AppResult<()> {
        let stream = self
            .inner
            .spawn_stream(session_id.clone(), worktree_id, cwd, cols, rows)?;
        self.track_stream(&session_id, &stream);
        forward_stream(stream, on_event);
        Ok(())
    }

    /// Spawns a PTY session without forwarding its output to a Tauri IPC
    /// channel. Used by brokered CLI operations (`tab open`, `agent start`) so
    /// the session exists and accumulates daemon scrollback until the frontend
    /// attaches to the tab.
    pub fn spawn_detached(
        &self,
        session_id: String,
        worktree_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> AppResult<()> {
        let request = request_spawn(session_id, worktree_id, cwd, cols, rows);
        let mut stream = self.connect_with_spawn()?;
        write_json_frame(&mut stream, &request)?;
        loop {
            match read_json_frame::<ServerFrame>(&mut stream)? {
                ServerFrame::Response(response) if response.request_id == request.request_id => {
                    if response.ok {
                        return Ok(());
                    }
                    return Err(AppError::Daemon(
                        response
                            .error
                            .unwrap_or_else(|| "spawn rejected".to_string()),
                    ));
                }
                ServerFrame::Hello(_)
                | ServerFrame::Response(_)
                | ServerFrame::Rpc(_)
                | ServerFrame::Event(_)
                | ServerFrame::Control(_)
                | ServerFrame::ControlResult(_) => {}
            }
        }
    }

    pub fn attach(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
        on_event: Channel<InvokeResponseBody>,
    ) -> AppResult<()> {
        let stream = self.inner.attach_stream(session_id.clone(), cols, rows)?;
        self.track_stream(&session_id, &stream);
        forward_stream(stream, on_event);
        Ok(())
    }

    /// Opens a live filesystem-change subscription for a worktree and forwards
    /// each [`FileChange`](pragma_constants::FileChange) to the webview as a JSON
    /// channel message. `root` is the trusted absolute worktree path resolved by
    /// the caller — it is never accepted from the frontend.
    pub fn watch_files(
        &self,
        worktree_id: String,
        root: String,
        on_event: Channel<InvokeResponseBody>,
    ) -> AppResult<()> {
        let stream = self.inner.subscribe_stream(
            ProtocolEventKind::FileChanged,
            Some(worktree_id),
            Some(root),
        )?;
        forward_file_stream(stream, on_event);
        Ok(())
    }

    pub fn write(&self, session_id: String, data: String) -> AppResult<()> {
        Ok(self.inner.write(session_id, data)?)
    }

    pub fn resize(&self, session_id: String, cols: u16, rows: u16) -> AppResult<()> {
        Ok(self.inner.resize(session_id, cols, rows)?)
    }

    pub fn kill(&self, session_id: String) -> AppResult<()> {
        // Close our side of the event-stream connection unconditionally, not
        // just when the server's Exit-driven cleanup happens to run: this is
        // the client's only guaranteed chance to release the thread + fd it
        // holds for this session.
        self.close_stream(&session_id);
        Ok(self.inner.kill(session_id)?)
    }

    pub fn kill_for_cwd(&self, path: String) -> AppResult<()> {
        Ok(self.inner.kill_for_cwd(path)?)
    }

    pub fn mark_agents_seen(&self, tab_id: String) -> AppResult<()> {
        Ok(self.inner.mark_agents_seen(tab_id)?)
    }

    /// Sends a business-logic RPC to this project's host and returns the JSON
    /// response. The host executes `filesystem`/`git`/… against its own disk —
    /// the local managed server for local projects, the remote `pragma-server`
    /// over the SSH bridge for remote ones.
    pub fn rpc(
        &self,
        method: pragma_constants::ProtocolRpcMethod,
        payload: serde_json::Value,
    ) -> AppResult<serde_json::Value> {
        Ok(self.inner.rpc(method, payload)?)
    }

    pub fn restart(&self) -> AppResult<()> {
        Ok(self.inner.restart()?)
    }

    /// Ensures the local HTTP gateway is running for this managed-local server.
    ///
    /// The gateway writes `gateway.json` beside `daemon.sock`; `pragma-server`
    /// reads that file when spawning shells and injects `PRAGMA_GATEWAY_*` only
    /// into Pragma-owned terminal sessions.
    pub fn ensure_gateway(&self) -> AppResult<()> {
        let _stream = self.inner.connect_with_spawn()?;
        let socket_path = self.inner.socket_path();
        let discovery_path = gateway_discovery_path(&socket_path);
        if gateway_discovery_healthy(&discovery_path) {
            return Ok(());
        }
        Self::spawn_gateway(&socket_path)?;
        wait_for_gateway_ready(&discovery_path)
    }

    /// Reads the host server's advertised protocol version (used to verify a
    /// remote `pragma-server` is compatible before routing a project to it).
    pub fn server_protocol_version(&self) -> AppResult<u64> {
        Ok(self.inner.server_protocol_version()?)
    }

    pub fn read_log(&self) -> AppResult<String> {
        Ok(self.inner.read_log()?)
    }

    pub(crate) fn connect_with_spawn(&self) -> AppResult<UnixStream> {
        Ok(self.inner.connect_with_spawn()?)
    }

    fn spawn_gateway(socket_path: &Path) -> AppResult<()> {
        let mut command = if cfg!(debug_assertions) {
            let mut command = Command::new(cargo_executable());
            command.args(["run", "-p", "pragma-gateway", "--", "--socket"]);
            command.arg(socket_path);
            command.current_dir(workspace_root());
            command
        } else {
            let mut command = Command::new(sidecar_executable("pragma-gateway"));
            command.arg("--socket").arg(socket_path);
            command
        };
        command.stdin(Stdio::null());
        if let Ok(log_file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(gateway_log_path(socket_path))
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

    #[cfg(test)]
    fn socket_path(&self) -> PathBuf {
        self.inner.socket_path()
    }

    #[cfg(test)]
    fn log_path(&self) -> PathBuf {
        self.inner.log_path()
    }
}

/// Resolves the isolation channel for this build from its product name.
pub fn instance_channel(product_name: Option<&str>) -> String {
    pragma_client::instance_channel(product_name, &workspace_root())
}

/// Resolves the per-instance data directory for a channel.
pub fn instance_data_dir(app_data_dir: &Path, channel: &str) -> PathBuf {
    pragma_client::instance_data_dir(app_data_dir, channel)
}

pub(crate) fn sidecar_executable(name: &str) -> PathBuf {
    pragma_client::sidecar_executable(name)
}

pub(crate) fn cargo_executable() -> PathBuf {
    pragma_client::cargo_executable()
}

fn gateway_discovery_path(socket_path: &Path) -> PathBuf {
    socket_path.with_file_name(CONSTANTS.gateway.discovery_file.as_str())
}

fn gateway_log_path(socket_path: &Path) -> PathBuf {
    socket_path.with_file_name("gateway.log")
}

fn wait_for_gateway_ready(path: &Path) -> AppResult<()> {
    let deadline = Instant::now() + GATEWAY_READY_TIMEOUT;
    while Instant::now() < deadline {
        if gateway_discovery_healthy(path) {
            return Ok(());
        }
        thread::sleep(GATEWAY_READY_POLL);
    }
    Err(AppError::Daemon(format!(
        "gateway did not write discovery file at {}",
        path.display()
    )))
}

fn gateway_discovery_healthy(path: &Path) -> bool {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return false;
    };
    let Some(port) = value
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
    else {
        return false;
    };
    let protocol_matches = value
        .get("protocolVersion")
        .and_then(serde_json::Value::as_u64)
        .is_some_and(|version| version == CONSTANTS.daemon.protocol_version.get());
    let has_token = value
        .get("token")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|token| !token.is_empty());
    protocol_matches && has_token && gateway_health_probe(port)
}

fn gateway_health_probe(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(GATEWAY_READY_POLL));
    let _ = stream.set_write_timeout(Some(GATEWAY_READY_POLL));
    if stream
        .write_all(b"GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok() && response.starts_with("HTTP/1.1 200")
}

pub(crate) fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

fn forward_stream(mut stream: UnixStream, on_event: Channel<InvokeResponseBody>) {
    thread::spawn(move || {
        while let Ok(frame) = read_frame(&mut stream) {
            match frame {
                Frame::Output { data, .. } => {
                    if on_event.send(InvokeResponseBody::Raw(data)).is_err() {
                        break;
                    }
                }
                Frame::Json(bytes) => match serde_json::from_slice::<ServerFrame>(&bytes) {
                    Ok(ServerFrame::Event(EventFrame::Title { title, .. })) => {
                        if forward_event(&on_event, PtyEvent::Title { title }).is_err() {
                            break;
                        }
                    }
                    Ok(ServerFrame::Event(EventFrame::Exit { code, .. })) => {
                        let _ = forward_event(&on_event, PtyEvent::Exit { code });
                        break;
                    }
                    Ok(
                        ServerFrame::Hello(_)
                        | ServerFrame::Response(_)
                        | ServerFrame::Rpc(_)
                        | ServerFrame::Control(_)
                        | ServerFrame::ControlResult(_)
                        | ServerFrame::Event(
                            EventFrame::Output { .. }
                            | EventFrame::Agent { .. }
                            | EventFrame::Snapshot { .. }
                            | EventFrame::Delta { .. }
                            | EventFrame::EchoMode { .. },
                        ),
                    )
                    | Err(_) => {}
                },
                Frame::Input { .. } => {}
            }
        }
        let _ = stream.shutdown(Shutdown::Both);
    });
}

/// Forwards a worktree file-change subscription stream to the webview. Each
/// `fileChanged` delta carries `{ worktreeId, change }`; only the inner
/// `change` ([`FileChange`](pragma_constants::FileChange)) is relayed as a JSON
/// channel message. The initial empty snapshot and any other frame are ignored.
fn forward_file_stream(mut stream: UnixStream, on_event: Channel<InvokeResponseBody>) {
    thread::spawn(move || {
        while let Ok(frame) = read_frame(&mut stream) {
            let Frame::Json(bytes) = frame else {
                continue;
            };
            if let Ok(ServerFrame::Event(EventFrame::Delta { payload, .. })) =
                serde_json::from_slice::<ServerFrame>(&bytes)
            {
                let change = payload.get("change").cloned().unwrap_or(payload);
                let Ok(json) = serde_json::to_string(&change) else {
                    continue;
                };
                if on_event.send(InvokeResponseBody::Json(json)).is_err() {
                    break;
                }
            }
        }
        let _ = stream.shutdown(Shutdown::Both);
    });
}

fn forward_event(channel: &Channel<InvokeResponseBody>, event: PtyEvent) -> tauri::Result<()> {
    match event.into_body() {
        Some(body) => channel.send(body),
        None => Ok(()),
    }
}

impl From<ClientError> for AppError {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::Io(error) => Self::Io(error),
            ClientError::LockPoisoned => Self::LockPoisoned,
            other => Self::Daemon(other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::Path;
    use std::thread;

    use pragma_constants::CONSTANTS;

    use super::{gateway_discovery_healthy, instance_channel, instance_data_dir, PtyClient};

    #[test]
    fn log_path_sits_beside_socket() {
        let client = PtyClient::new(
            std::path::PathBuf::from("/tmp/pragma-test"),
            "pragma".to_string(),
        );
        let socket = client.socket_path();
        let log = client.log_path();
        assert_eq!(log.parent(), socket.parent());
        assert_eq!(log.file_name().and_then(|n| n.to_str()), Some("server.log"));
    }

    #[test]
    fn server_paths_are_channel_scoped() {
        let client = PtyClient::new(
            std::path::PathBuf::from("/tmp/pragma-test"),
            "pragma-dev-abc123".to_string(),
        );
        let socket = client.socket_path();
        let channel_dir = socket.parent().expect("socket has a parent dir");
        assert_eq!(
            channel_dir.file_name().and_then(|n| n.to_str()),
            Some("pragma-dev-abc123"),
        );
    }

    #[test]
    fn channel_follows_product_identity() {
        assert_eq!(instance_channel(Some("Pragma")), "pragma");
        assert_eq!(instance_channel(None), "pragma");
        let dev = instance_channel(Some("Pragma Dev"));
        assert!(dev.starts_with("pragma-dev-"), "got {dev}");
        assert_eq!(dev, instance_channel(Some("Pragma Dev")));
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

    #[test]
    fn gateway_discovery_healthy_requires_live_gateway() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test listener");
        let port = listener.local_addr().expect("listener addr").port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept health probe");
            let mut request = [0; 256];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .expect("write response");
        });
        let dir = tempfile::tempdir().expect("temp dir");
        let discovery_path = dir.path().join(CONSTANTS.gateway.discovery_file.as_str());
        std::fs::write(
            &discovery_path,
            format!(
                r#"{{"port":{port},"token":"secret","pid":123,"protocolVersion":{}}}"#,
                CONSTANTS.daemon.protocol_version.get()
            ),
        )
        .expect("write discovery");

        assert!(gateway_discovery_healthy(&discovery_path));
        handle.join().expect("health server joined");
    }

    #[test]
    fn gateway_discovery_healthy_rejects_stale_protocol() {
        let dir = tempfile::tempdir().expect("temp dir");
        let discovery_path = dir.path().join(CONSTANTS.gateway.discovery_file.as_str());
        std::fs::write(
            &discovery_path,
            r#"{"port":4567,"token":"secret","pid":123,"protocolVersion":0}"#,
        )
        .expect("write discovery");

        assert!(!gateway_discovery_healthy(&discovery_path));
    }

    #[test]
    fn read_log_is_empty_when_missing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let prev = std::env::var_os("XDG_RUNTIME_DIR");
        std::env::remove_var("XDG_RUNTIME_DIR");
        let client = PtyClient::new(dir.path().to_path_buf(), "pragma".to_string());
        assert_eq!(client.read_log().expect("read empty log"), "");
        std::fs::create_dir_all(client.log_path().parent().expect("log dir"))
            .expect("create channel dir");
        std::fs::write(client.log_path(), "boot\n").expect("write log");
        assert_eq!(client.read_log().expect("read log"), "boot\n");
        if let Some(value) = prev {
            std::env::set_var("XDG_RUNTIME_DIR", value);
        }
    }
}
