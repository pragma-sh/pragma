mod automations;
mod plugins_host;
mod registry;
mod session;

use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::Shutdown;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use daemonize::Daemonize;
use pragma_constants::{ProtocolEventKind, ProtocolRpcMethod, CONSTANTS};
use pragma_core::rpc::protocol_error_code;
use pragma_core::Core;

use pragma_protocol::{
    read_frame, read_json_frame, write_json_frame, write_output_frame, ControlEnvelope,
    ControlResult, EventFrame, Frame, HelloFrame, ProtocolError, RequestFrame, RequestKind,
    ResponseFrame, RpcError, RpcResponseFrame, ServerFrame,
};
use registry::Registry;

/// How long a brokered `Control` request waits for the app to reply before the
/// server gives up and fails the CLI request. A crashed/hung app cannot wedge
/// the CLI.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(10);

/// How often `forward_events` checks whether its connection has been closed,
/// when the session it is streaming has otherwise gone quiet. A connection
/// abandoned without the session producing any further output (an idle shell
/// sitting at a prompt) would otherwise block on `rx.recv()` forever — the
/// disconnect is only ever discovered by an actual write failing, and if no
/// further event ever arrives, that write never happens. This bounds how
/// long the thread (and the fd its writer holds) can outlive the client that
/// dropped it. See `session_streams` in `apps/pragma/src-tauri/src/pty.rs`
/// for the client-side half of this cleanup.
const EVENT_STREAM_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Upper bound on how long a single write to a client socket may stall before
/// the connection is declared dead. A client that stops draining its socket
/// (a wedged webview, a half-dead SSH bridge that never RSTs) otherwise blocks
/// the writing thread forever *while it holds the connection's writer mutex*,
/// and — because `Session::broadcast` never blocks — the abandoned subscriber's
/// event channel then grows without bound for as long as the session keeps
/// producing output. A healthy local client drains the socket in microseconds;
/// ten seconds of zero progress means the peer is gone. Applies to the shared
/// socket fd, so response, event, and brokered-control writes are all covered.
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(10);

const DETACH_FLAG: &str = "--detach";

/// The channel that isolates this server from a differently-built sibling.
///
/// The Pragma app picks the channel (see `instance_channel` in `pty.rs`) and
/// hands it to us via `PRAGMA_SERVER_CHANNEL` when it spawns us, so a dev server
/// and a prod server - and two dev worktrees' servers - resolve different
/// socket/lock/log paths regardless of compile profile. The fallback only
/// applies when the server is launched directly (e.g. `cargo run -p
/// pragma-server`): a debug build derives the same per-worktree
/// `pragma-dev-<hash>` the app would, so a hand-run server in a worktree serves
/// that worktree's app; a release build falls back to the production channel.
fn server_channel() -> String {
    std::env::var("PRAGMA_SERVER_CHANNEL")
        .or_else(|_| std::env::var("PRAGMA_DAEMON_CHANNEL"))
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(default_server_channel)
}

/// Compile-profile fallback channel, matching the app's `instance_channel`: a
/// debug build resolves the per-worktree dev channel from its own workspace
/// root, a release build the stable production channel.
fn default_server_channel() -> String {
    if cfg!(debug_assertions) {
        pragma_protocol::dev_channel(&workspace_root())
    } else {
        pragma_protocol::PROD_CHANNEL.to_string()
    }
}

/// Absolute workspace root this server was compiled in, derived from
/// `CARGO_MANIFEST_DIR` (`<root>/crates/pragma-server`, two ancestors up). It
/// resolves to the same path the app derives from its own manifest, so both
/// hash to the same `pragma-dev-<hash>` channel for a given worktree.
fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let paths = server_paths();
    fs::create_dir_all(&paths.dir)?;
    detach_if_requested(&paths, should_detach())?;
    remove_stale_files(&paths.socket, &paths.lock);
    let mut lock = acquire_lock(&paths.lock)?;
    // Record our PID so the app can replace *this* server precisely if it ever
    // turns out to speak an incompatible protocol version (see the hello frame).
    writeln!(lock, "{}", std::process::id())?;
    lock.flush()?;
    let _lock = lock;
    if paths.socket.exists() {
        fs::remove_file(&paths.socket)?;
    }
    let listener = UnixListener::bind(&paths.socket)?;
    set_socket_permissions(&paths.socket)?;

    let registry = Arc::new(Registry::new(
        paths.socket.clone(),
        paths.dir.clone(),
        workspace_root(),
    ));
    let core = Arc::new(Core);
    loop {
        // A failed accept (e.g. EMFILE from a leaked-connection fd exhaustion)
        // must not take the whole process down with it: every other
        // already-connected terminal's socket would die alongside it, turning
        // one resource hiccup into a total, silent freeze. Log and keep
        // serving; a transient failure (like EMFILE) is often self-resolving
        // once some existing connections close.
        let (stream, _) = match listener.accept() {
            Ok(accepted) => accepted,
            Err(err) => {
                eprintln!("accept failed: {err}");
                // Bound the spin rate on a persistent accept error (e.g.
                // EMFILE from fd exhaustion): without a delay this would log
                // and retry at full CPU speed until an fd is freed elsewhere.
                thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        let registry = Arc::clone(&registry);
        let core = Arc::clone(&core);
        thread::spawn(move || {
            handle_client(stream, &registry, &core);
        });
    }
}

fn handle_client(mut stream: UnixStream, registry: &Arc<Registry>, core: &Arc<Core>) {
    // Bound every write to this client so a peer that stops reading cannot
    // pin a writer thread (and the mutex it holds) forever — see
    // `CLIENT_WRITE_TIMEOUT`. Reads stay blocking: an idle connection is fine.
    let _ = stream.set_write_timeout(Some(CLIENT_WRITE_TIMEOUT));
    let writer = match stream.try_clone() {
        Ok(stream) => Arc::new(Mutex::new(stream)),
        Err(_) => return,
    };
    // Greet the connection so the app can verify it is talking to a server that
    // speaks its protocol version (and replace it otherwise). Must be the first
    // frame written; the app consumes exactly one hello before any request.
    if let Ok(mut writer_guard) = writer.lock() {
        let hello = ServerFrame::Hello(HelloFrame {
            protocol_version: CONSTANTS.daemon.protocol_version.get(),
        });
        if write_json_frame(&mut *writer_guard, &hello).is_err() {
            return;
        }
    }
    // Peek the first request to decide whether this connection is the
    // controller (RegisterController) or a normal client. The controller loop
    // is structurally different: it only sends ControlResult replies.
    let Some(first) = next_request(&mut stream, registry) else {
        let _ = stream.shutdown(Shutdown::Both);
        return;
    };
    if matches!(first.kind, RequestKind::RegisterController) {
        // The app registered as the single controller. The controller's
        // `ControlResult` replies are read on this same connection thread and
        // routed to waiting CLI waiters by `request_id`.
        let _ = registry.register_controller(Arc::clone(&writer));
        controller_reply_loop(&mut stream, registry);
        registry.clear_controller();
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }
    // Shared with any `forward_events` thread spawned for this connection so
    // it can stop polling as soon as we notice the client is gone, instead of
    // only noticing on its next write attempt (see `EVENT_STREAM_POLL_INTERVAL`).
    let closed = Arc::new(AtomicBool::new(false));
    handle_client_request(first, &writer, registry, core, &closed);
    while let Some(request) = next_request(&mut stream, registry) {
        handle_client_request(request, &writer, registry, core, &closed);
    }
    closed.store(true, Ordering::Relaxed);
    let _ = stream.shutdown(Shutdown::Both);
}

/// Reads frames off `stream` until a JSON request arrives. A binary `Input`
/// frame is written straight to its session via `Registry::write_bytes` and
/// skipped — input is fire-and-forget on the hot path, with no `RequestFrame`
/// or response involved. `Output` frames are never sent by a client and are
/// discarded. Returns `None` once the connection errors, closes, or sends a
/// malformed JSON frame.
fn next_request(stream: &mut UnixStream, registry: &Registry) -> Option<RequestFrame> {
    loop {
        let bytes = match read_frame(stream).ok()? {
            Frame::Json(bytes) => bytes,
            Frame::Input { session_id, data } => {
                let _ = registry.write_bytes(&session_id, &data);
                continue;
            }
            Frame::Output { .. } => continue,
        };
        return serde_json::from_slice(&bytes).ok();
    }
}

/// Drains `ControlResult` replies from the controller connection and routes each
/// to its waiting `request_id` in `Registry.pending`. Runs on the connection's
/// own thread until the controller disconnects.
fn controller_reply_loop(stream: &mut UnixStream, registry: &Arc<Registry>) {
    while let Ok(request) = read_json_frame::<RequestFrame>(stream) {
        if let RequestKind::ControlResult = request.kind {
            if let Some(result) = request.control_result {
                registry.route_control_result(&request.request_id, result);
            }
        }
        // Other request kinds from the controller are unexpected and ignored.
    }
}

/// Handles one request frame on a normal (non-controller) connection.
fn handle_client_request(
    request: RequestFrame,
    writer: &Arc<Mutex<UnixStream>>,
    registry: &Arc<Registry>,
    core: &Arc<Core>,
    closed: &Arc<AtomicBool>,
) {
    let is_control = matches!(request.kind, RequestKind::Control);
    let request_id = request.request_id.clone();
    let (response, rpc_response, event_stream, control_rx) =
        match handle_request(request, registry, core) {
            Ok(outcome) => (
                Some(ResponseFrame {
                    request_id: request_id.clone(),
                    ok: true,
                    error: None,
                }),
                None,
                outcome.event_stream,
                outcome.control_rx,
            ),
            Err(HandledRequestError::Rpc(response)) => (None, Some(*response), None, None),
            Err(HandledRequestError::Control(response)) => {
                // Brokered request failed synchronously (e.g. no controller).
                if let Ok(mut writer_guard) = writer.lock() {
                    write_frame_or_hang_up(
                        &mut writer_guard,
                        &ServerFrame::ControlResult(response),
                    );
                }
                return;
            }
            Err(error) => (
                Some(ResponseFrame {
                    request_id: request_id.clone(),
                    ok: false,
                    error: Some(error.to_string()),
                }),
                None,
                None,
                None,
            ),
        };
    if is_control {
        if let Some(rx) = control_rx {
            // Wait for the controller's reply (bounded by CONTROL_TIMEOUT), then
            // forward it to the CLI as a ServerFrame::ControlResult.
            if let Ok(result) = rx.recv_timeout(CONTROL_TIMEOUT) {
                if let Ok(mut writer_guard) = writer.lock() {
                    write_frame_or_hang_up(&mut writer_guard, &ServerFrame::ControlResult(result));
                }
            } else {
                // Timed out or controller dropped — fail clearly and clear
                // the pending slot so it does not leak.
                registry.cancel_pending(&request_id);
                if let Ok(mut writer_guard) = writer.lock() {
                    write_frame_or_hang_up(
                        &mut writer_guard,
                        &ServerFrame::ControlResult(ControlResult {
                            ok: false,
                            payload: None,
                            error: Some("Pragma is not running. Launch the app first.".to_string()),
                        }),
                    );
                }
            }
        }
        return;
    }
    if let Ok(mut writer_guard) = writer.lock() {
        if let Some(response) = response {
            if !write_frame_or_hang_up(&mut writer_guard, &ServerFrame::Response(response)) {
                return;
            }
        }
        if let Some(response) = rpc_response {
            if !write_frame_or_hang_up(&mut writer_guard, &ServerFrame::Rpc(response)) {
                return;
            }
        }
    }
    if let Some(stream) = event_stream {
        forward_events(
            stream.scrollback,
            stream.rx,
            Arc::clone(writer),
            Arc::clone(registry),
            Arc::clone(closed),
        );
    }
}

fn handle_request(
    request: RequestFrame,
    registry: &Registry,
    core: &Core,
) -> Result<Outcome, HandledRequestError> {
    match request.kind {
        RequestKind::Spawn => {
            let session_id = required(request.session_id, "sessionId")?;
            let worktree_id = required(request.worktree_id, "worktreeId")?;
            let cwd = required(request.cwd, "cwd")?;
            let cols = request.cols.unwrap_or(80);
            let rows = request.rows.unwrap_or(24);
            let (scrollback, rx) = registry
                .spawn(session_id, worktree_id, cwd, cols, rows)
                .map_err(|err| HandledRequestError::Request(err.to_string()))?;
            Ok(Outcome {
                event_stream: Some(EventStream { scrollback, rx }),
                control_rx: None,
            })
        }
        RequestKind::Attach => {
            let session_id = required(request.session_id, "sessionId")?;
            // Only resize when the attacher declares a viewport; a size-less
            // attach (plugin watcher) observes without disturbing the PTY grid.
            let size = request.cols.zip(request.rows);
            let (scrollback, rx) = registry
                .attach(&session_id, size)
                .map_err(|err| HandledRequestError::Request(err.to_string()))?;
            Ok(Outcome {
                event_stream: Some(EventStream { scrollback, rx }),
                control_rx: None,
            })
        }
        RequestKind::Write => registry
            .write(
                &required(request.session_id, "sessionId")?,
                &required(request.data, "data")?,
            )
            .map(|()| Outcome::default())
            .map_err(|err| HandledRequestError::Request(err.to_string())),
        RequestKind::Resize => registry
            .resize(
                &required(request.session_id, "sessionId")?,
                request.cols.unwrap_or(80),
                request.rows.unwrap_or(24),
            )
            .map(|()| Outcome::default())
            .map_err(|err| HandledRequestError::Request(err.to_string())),
        RequestKind::Kill => registry
            .kill(&required(request.session_id, "sessionId")?)
            .map(|()| Outcome::default())
            .map_err(|err| HandledRequestError::Request(err.to_string())),
        RequestKind::KillForCwd => registry
            .kill_for_cwd(&required(request.data, "data")?)
            .map(|_count| Outcome::default())
            .map_err(|err| HandledRequestError::Request(err.to_string())),
        RequestKind::AgentReport => {
            let payload = serde_json::from_str(&required(request.data, "data")?)
                .map_err(|err| HandledRequestError::Request(err.to_string()))?;
            registry
                .report_agent(payload)
                .map(|()| Outcome::default())
                .map_err(|err| HandledRequestError::Request(err.to_string()))
        }
        RequestKind::AgentMessage
        | RequestKind::AgentDecision
        | RequestKind::AgentAnswer
        | RequestKind::AgentInput
        | RequestKind::AgentInterrupt => {
            handle_agent_publish(&request.kind, request.data, registry)
        }
        RequestKind::SubscribeAgents => {
            let (scrollback, rx) = registry
                .subscribe_agents()
                .map_err(|err| HandledRequestError::Request(err.to_string()))?;
            Ok(Outcome {
                event_stream: Some(EventStream { scrollback, rx }),
                control_rx: None,
            })
        }
        RequestKind::MarkAgentsSeen => {
            registry.mark_agents_seen_for_tab(&required(request.session_id, "sessionId")?);
            Ok(Outcome::default())
        }
        RequestKind::Rpc => Err(HandledRequestError::Rpc(Box::new(handle_rpc_request(
            request, registry, core,
        )?))),
        RequestKind::Subscribe => Ok(Outcome {
            event_stream: Some(subscription_snapshot(request, registry)?),
            control_rx: None,
        }),
        // The controller registers on a connection whose loop is handled in
        // `handle_client` before reaching here. A second `RegisterController`
        // on a non-controller connection is a no-op acknowledgement.
        RequestKind::RegisterController | RequestKind::ControlResult => Ok(Outcome::default()),
        RequestKind::Control => handle_control_request(request, registry),
        RequestKind::PublishWorkspace => {
            let snapshot =
                parse_data::<pragma_protocol::WorkspaceSnapshot>(&required(request.data, "data")?)?;
            registry.publish_workspace(snapshot);
            Ok(Outcome::default())
        }
    }
}

/// Handles the fire-and-forget agent publish frames (message, decision, answer,
/// input, interrupt): parse `data` into the payload and fan it out through the
/// registry.
/// The caller matches these kinds, so any other kind is unreachable.
fn handle_agent_publish(
    kind: &RequestKind,
    data: Option<String>,
    registry: &Registry,
) -> Result<Outcome, HandledRequestError> {
    let data = required(data, "data")?;
    match kind {
        RequestKind::AgentMessage => registry.report_agent_message(parse_data(&data)?),
        RequestKind::AgentDecision => registry.report_agent_decision(parse_data(&data)?),
        RequestKind::AgentAnswer => registry.report_agent_answer(parse_data(&data)?),
        RequestKind::AgentInput => registry.report_agent_input(parse_data(&data)?),
        RequestKind::AgentInterrupt => registry.report_agent_interrupt(parse_data(&data)?),
        _ => unreachable!("handle_agent_publish is only called for agent publish kinds"),
    }
    Ok(Outcome::default())
}

/// Deserializes a request's JSON `data` payload, mapping parse failures to a
/// client request error.
fn parse_data<T: serde::de::DeserializeOwned>(data: &str) -> Result<T, HandledRequestError> {
    serde_json::from_str(data).map_err(|err| HandledRequestError::Request(err.to_string()))
}

fn handle_rpc_request(
    request: RequestFrame,
    registry: &Registry,
    core: &Core,
) -> Result<RpcResponseFrame, HandledRequestError> {
    let Some(rpc) = request.rpc else {
        return Err(HandledRequestError::Request(
            "missing rpc payload".to_string(),
        ));
    };
    let request_id = request.request_id;
    if matches!(rpc.method, ProtocolRpcMethod::Automations) {
        return Ok(match registry.handle_automation_rpc(rpc.payload) {
            Ok(payload) => RpcResponseFrame {
                request_id,
                ok: true,
                payload: Some(payload),
                error: None,
            },
            Err(error) => RpcResponseFrame {
                request_id,
                ok: false,
                payload: None,
                error: Some(RpcError {
                    code: pragma_constants::ProtocolErrorCode::Internal,
                    message: error.to_string(),
                }),
            },
        });
    }
    if matches!(rpc.method, ProtocolRpcMethod::Plugins) {
        return Ok(match registry.handle_plugins_rpc(&rpc.payload) {
            Ok(payload) => RpcResponseFrame {
                request_id,
                ok: true,
                payload: Some(payload),
                error: None,
            },
            Err(error) => RpcResponseFrame {
                request_id,
                ok: false,
                payload: None,
                error: Some(RpcError {
                    code: pragma_constants::ProtocolErrorCode::Internal,
                    message: error.to_string(),
                }),
            },
        });
    }
    Ok(match core.handle_rpc(rpc.method, rpc.payload) {
        Ok(payload) => RpcResponseFrame {
            request_id,
            ok: true,
            payload: Some(payload),
            error: None,
        },
        Err(error) => RpcResponseFrame {
            request_id,
            ok: false,
            payload: None,
            error: Some(RpcError {
                code: protocol_error_code(&error),
                message: error.to_string(),
            }),
        },
    })
}

fn handle_control_request(
    request: RequestFrame,
    registry: &Registry,
) -> Result<Outcome, HandledRequestError> {
    let Some(control) = request.control else {
        return Err(HandledRequestError::Request(
            "missing control payload".to_string(),
        ));
    };
    let request_id = request.request_id;
    let Some(writer) = registry
        .controller_writer()
        .map_err(|err| HandledRequestError::Request(err.to_string()))?
    else {
        return Err(HandledRequestError::Control(app_not_running_result()));
    };
    let rx = registry
        .pending_control(request_id.clone())
        .map_err(|err| HandledRequestError::Request(err.to_string()))?;
    let envelope = ControlEnvelope {
        request_id: request_id.clone(),
        method: control.method,
        payload: control.payload,
    };
    // A failed forward also hangs the controller connection up: its reply loop
    // then unblocks and clears the controller, so the server converges on the
    // "app offline" state instead of brokering onto a corrupt stream.
    let forwarded = writer.lock().is_ok_and(|mut writer_guard| {
        write_frame_or_hang_up(&mut writer_guard, &ServerFrame::Control(envelope))
    });
    if !forwarded {
        registry.cancel_pending(&request_id);
        return Err(HandledRequestError::Control(app_not_running_result()));
    }
    Ok(Outcome {
        event_stream: None,
        control_rx: Some(rx),
    })
}

fn app_not_running_result() -> ControlResult {
    ControlResult {
        ok: false,
        payload: None,
        error: Some("Pragma is not running. Launch the app first.".to_string()),
    }
}

/// Outcome of a normal client request: an event stream to forward, or a control
/// reply channel to await.
#[derive(Default)]
struct Outcome {
    event_stream: Option<EventStream>,
    control_rx: Option<std::sync::mpsc::Receiver<ControlResult>>,
}

enum HandledRequestError {
    Request(String),
    Rpc(Box<RpcResponseFrame>),
    /// A brokered control request failed synchronously (no controller, or the
    /// forward write failed). The CLI receives this as a `ControlResult` frame.
    Control(ControlResult),
}

impl From<String> for HandledRequestError {
    fn from(message: String) -> Self {
        Self::Request(message)
    }
}

impl std::fmt::Display for HandledRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Request(message) => formatter.write_str(message),
            Self::Rpc(response) => write!(formatter, "rpc response {}", response.request_id),
            Self::Control(_) => formatter.write_str("control failed"),
        }
    }
}

fn subscription_snapshot(
    request: RequestFrame,
    registry: &Registry,
) -> Result<EventStream, HandledRequestError> {
    let Some(subscription) = request.subscription else {
        return Err(HandledRequestError::Request(
            "missing subscription payload".to_string(),
        ));
    };
    // The filesystem-change stream is backed by a live per-worktree watcher; it
    // needs the worktree id (for delta labeling) and the trusted absolute root
    // (`cwd`) to watch. Other event kinds are not wired to a source yet and
    // return an empty, never-updating snapshot.
    if matches!(subscription.event, ProtocolEventKind::FileChanged) {
        let worktree_id = required(request.worktree_id, "worktreeId")?;
        let root = required(request.cwd, "cwd")?;
        let (scrollback, rx) = registry
            .subscribe_files(worktree_id, &root)
            .map_err(|err| HandledRequestError::Request(err.to_string()))?;
        return Ok(EventStream { scrollback, rx });
    }
    if matches!(subscription.event, ProtocolEventKind::AutomationPending) {
        let (scrollback, rx) = registry
            .subscribe_automation_pending()
            .map_err(|err| HandledRequestError::Request(err.to_string()))?;
        return Ok(EventStream { scrollback, rx });
    }
    if matches!(subscription.event, ProtocolEventKind::AutomationsChanged) {
        let (scrollback, rx) = registry
            .subscribe_automations_changed()
            .map_err(|err| HandledRequestError::Request(err.to_string()))?;
        return Ok(EventStream { scrollback, rx });
    }
    if matches!(subscription.event, ProtocolEventKind::Workspace) {
        let (scrollback, rx) = registry
            .subscribe_workspace()
            .map_err(|err| HandledRequestError::Request(err.to_string()))?;
        return Ok(EventStream { scrollback, rx });
    }
    let (_tx, rx) = std::sync::mpsc::channel();
    Ok(EventStream {
        scrollback: vec![EventFrame::Snapshot {
            subscription: subscription.event,
            payload: serde_json::Value::Array(Vec::new()),
        }],
        rx,
    })
}

struct EventStream {
    scrollback: Vec<EventFrame>,
    rx: Receiver<EventFrame>,
}

fn forward_events(
    scrollback: Vec<EventFrame>,
    rx: Receiver<EventFrame>,
    writer: Arc<Mutex<UnixStream>>,
    registry: Arc<Registry>,
    closed: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        for event in scrollback {
            // A replayed `Exit` means we attached to a session whose process
            // already ended with no forwarder around to observe it (the app
            // was closed when the shell exited). Reap it now, exactly as the
            // live path below does, so it doesn't sit in the registry forever.
            if let EventFrame::Exit { session_id, .. } = &event {
                registry.remove_exited(session_id);
            }
            if !write_or_hang_up(&writer, event) {
                return;
            }
        }
        loop {
            if closed.load(Ordering::Relaxed) {
                break;
            }
            // Poll rather than block on `rx.recv()` so a connection whose
            // client has already disconnected doesn't wait indefinitely on a
            // session that has otherwise gone quiet — see
            // `EVENT_STREAM_POLL_INTERVAL`.
            let event = match rx.recv_timeout(EVENT_STREAM_POLL_INTERVAL) {
                Ok(event) => event,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            if let EventFrame::Exit { session_id, .. } = &event {
                // The session's process exited on its own (no `Kill` request
                // ever ran): drop it from the registry now so its PTY master
                // fd and scrollback don't outlive it.
                registry.remove_exited(session_id);
            }
            if !write_or_hang_up(&writer, event) {
                break;
            }
        }
    });
}

/// Writes one event to the client, and on failure shuts the whole connection
/// down. A failed write here is either a dead peer or a timed-out one (see
/// `CLIENT_WRITE_TIMEOUT`); in the timeout case part of a frame may already be
/// on the wire, so the stream's framing can no longer be trusted — no other
/// thread may keep writing responses onto it. Returns whether the write
/// succeeded.
fn write_or_hang_up(writer: &Arc<Mutex<UnixStream>>, event: EventFrame) -> bool {
    let Ok(mut writer) = writer.lock() else {
        return false;
    };
    if write_event(&mut writer, event).is_err() {
        let _ = writer.shutdown(Shutdown::Both);
        return false;
    }
    true
}

/// Writes one JSON frame to the client, and on failure shuts the connection
/// down for the same reason as [`write_or_hang_up`]: after a timed-out partial
/// write the stream's framing cannot be trusted. Returns whether the write
/// succeeded.
fn write_frame_or_hang_up(writer: &mut UnixStream, frame: &ServerFrame) -> bool {
    if write_json_frame(writer, frame).is_err() {
        let _ = writer.shutdown(Shutdown::Both);
        return false;
    }
    true
}

/// Writes one event to the client: output goes out as a binary frame (raw bytes,
/// no JSON escaping), while title/exit stay JSON control frames.
fn write_event(writer: &mut UnixStream, event: EventFrame) -> Result<(), ProtocolError> {
    match event {
        EventFrame::Output { session_id, data } => write_output_frame(writer, &session_id, &data),
        other => write_json_frame(writer, &ServerFrame::Event(other)),
    }
}

fn required(value: Option<String>, name: &str) -> Result<String, String> {
    value.ok_or_else(|| format!("missing {name}"))
}

struct ServerPaths {
    dir: PathBuf,
    socket: PathBuf,
    lock: PathBuf,
    log: PathBuf,
}

fn server_paths() -> ServerPaths {
    let channel = server_channel();
    let dir = if cfg!(target_os = "linux") {
        std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("PRAGMA_APP_DATA_DIR").map(PathBuf::from))
            .unwrap_or_else(default_app_data_dir)
            .join(&channel)
    } else {
        std::env::var_os("PRAGMA_APP_DATA_DIR")
            .map_or_else(default_app_data_dir, PathBuf::from)
            .join(&channel)
    };
    ServerPaths {
        socket: dir.join("daemon.sock"),
        lock: dir.join("server.lock"),
        log: dir.join("server.log"),
        dir,
    }
}

fn should_detach() -> bool {
    std::env::args_os().any(|arg| arg == OsStr::new(DETACH_FLAG))
}

fn detach_if_requested(
    paths: &ServerPaths,
    should_detach: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if !should_detach {
        return Ok(());
    }

    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log)?;
    let stderr = stdout.try_clone()?;
    Daemonize::new()
        .working_directory(&paths.dir)
        .stdout(stdout)
        .stderr(stderr)
        .start()?;
    Ok(())
}

fn default_app_data_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(std::env::temp_dir, PathBuf::from);
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/com.pragma.app")
    } else {
        home.join(".local/share/com.pragma.app")
    }
}

fn acquire_lock(lock_path: &Path) -> Result<File, Box<dyn std::error::Error>> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path)
        .map_err(|err| {
            format!(
                "pragma-server is already running or lock is stale at {}: {err}",
                lock_path.display()
            )
            .into()
        })
}

fn set_socket_permissions(socket: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut permissions = fs::metadata(socket)?.permissions();
    permissions.set_mode(0o600);
    fs::set_permissions(socket, permissions)?;
    Ok(())
}

fn remove_stale_files(socket: &Path, lock: &Path) {
    if socket.exists() && UnixStream::connect(socket).is_err() {
        let _ = fs::remove_file(socket);
        let _ = fs::remove_file(lock);
    } else if lock.exists() && !socket.exists() {
        let _ = fs::remove_file(lock);
    }
}
