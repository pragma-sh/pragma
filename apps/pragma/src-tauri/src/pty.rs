use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::thread;

use pragma_client::{ClientError, LocalServerConfig, PragmaClient};
use pragma_protocol::{read_frame, EventFrame, Frame, ProtocolEventKind, ServerFrame};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::error::{AppError, AppResult};

/// Tauri-facing PTY adapter. Transport, bootstrap, and frame request logic live
/// in `pragma-client`; this wrapper only bridges raw server frames to the
/// webview channel shape expected by the frontend.
#[derive(Clone)]
pub struct PtyClient {
    inner: PragmaClient,
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
        }
    }

    /// Builds a client over an already-listening Unix socket — the local end of
    /// an SSH streamlocal bridge to a remote `pragma-server`. Unlike the
    /// managed-local client, this never spawns or replaces the server.
    pub fn new_socket(socket_path: PathBuf) -> Self {
        Self {
            inner: PragmaClient::new_socket(socket_path),
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
            .spawn_stream(session_id, worktree_id, cwd, cols, rows)?;
        forward_stream(stream, on_event);
        Ok(())
    }

    pub fn attach(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
        on_event: Channel<InvokeResponseBody>,
    ) -> AppResult<()> {
        let stream = self.inner.attach_stream(session_id, cols, rows)?;
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
    use std::path::Path;

    use super::{instance_channel, instance_data_dir, PtyClient};

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
