mod automations;
mod plugins_host;
mod ports;
mod registry;
mod session;
mod tunnel;
mod watchers;

use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::Shutdown;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use pragma_constants::{ProtocolEventKind, ProtocolRpcMethod, CONSTANTS};
use pragma_core::rpc::protocol_error_code;
use pragma_core::Core;
use pragma_platform::ipc::{self, LocalStream};

use pragma_protocol::limits::raise_open_file_limit;
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

/// Runs this process as a stdio relay to an already-running server instead of
/// starting one. See [`relay_stdio`].
const RELAY_FLAG: &str = "--relay";

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
    if should_relay() {
        return relay_stdio(&paths.socket);
    }
    fs::create_dir_all(&paths.dir)?;
    detach_if_requested(&paths, should_detach())?;
    // Before anything opens an fd, and before any session shell is spawned:
    // children inherit the limit in force at spawn time, so raising it here is
    // what keeps a tab full of tests from hitting the launchd default of 256.
    match raise_open_file_limit() {
        Ok(limit) => eprintln!("open-file soft limit: {limit}"),
        Err(err) => eprintln!("could not raise the open-file limit: {err}"),
    }
    // Holding the advisory lock is what makes this process *the* server for this
    // channel; everything below (unlinking and rebinding the socket) is only safe
    // once no other server can be doing the same thing concurrently.
    let mut lock = acquire_lock(&paths.lock)?;
    // Record our PID so the app can replace *this* server precisely if it ever
    // turns out to speak an incompatible protocol version (see the hello frame).
    lock.set_len(0)?;
    writeln!(lock, "{}", std::process::id())?;
    lock.flush()?;
    let _lock = lock;
    take_socket_path(&paths.socket)?;
    // `ipc::bind` restricts the socket to its owner, on every platform.
    let listener = ipc::bind(&paths.socket)?;

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

fn handle_client(mut stream: LocalStream, registry: &Arc<Registry>, core: &Arc<Core>) {
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
fn next_request(stream: &mut LocalStream, registry: &Registry) -> Option<RequestFrame> {
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
fn controller_reply_loop(stream: &mut LocalStream, registry: &Arc<Registry>) {
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
    writer: &Arc<Mutex<LocalStream>>,
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

fn handle_ports_rpc(
    request_id: String,
    payload: serde_json::Value,
    registry: &Registry,
) -> Result<RpcResponseFrame, HandledRequestError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PortsRequest {
        worktree_ids: Vec<String>,
    }
    let payload = serde_json::from_value::<PortsRequest>(payload)
        .map_err(|error| HandledRequestError::Request(error.to_string()))?;
    Ok(match registry.list_open_ports(&payload.worktree_ids) {
        Ok(ports) => RpcResponseFrame {
            request_id,
            ok: true,
            payload: Some(
                serde_json::to_value(ports)
                    .map_err(|error| HandledRequestError::Request(error.to_string()))?,
            ),
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
    })
}

fn handle_tabs_rpc(
    request_id: String,
    payload: serde_json::Value,
    registry: &Registry,
) -> Result<RpcResponseFrame, HandledRequestError> {
    let request = serde_json::from_value::<pragma_core::tabs::TabsRequest>(payload)
        .map_err(|error| HandledRequestError::Request(error.to_string()))?;
    let result = match request {
        pragma_core::tabs::TabsRequest::SetAgent {
            tab,
            agent_id,
            title,
        } => registry
            .set_tab_agent(*tab, &agent_id, &title)
            .and(Ok(serde_json::Value::Null)),
        pragma_core::tabs::TabsRequest::SetTitle { tab_id, title } => registry
            .set_agent_tab_title(&tab_id, &title)
            .and(Ok(serde_json::Value::Null)),
        pragma_core::tabs::TabsRequest::ListAgents { tab_ids } => registry
            .tab_agent_metadata(&tab_ids)
            .and_then(|tabs| serde_json::to_value(tabs).map_err(|error| error.to_string())),
    };
    Ok(match result {
        Ok(payload) => RpcResponseFrame {
            request_id,
            ok: true,
            payload: Some(payload),
            error: None,
        },
        Err(message) => RpcResponseFrame {
            request_id,
            ok: false,
            payload: None,
            error: Some(RpcError {
                code: pragma_constants::ProtocolErrorCode::Internal,
                message,
            }),
        },
    })
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
    if matches!(rpc.method, ProtocolRpcMethod::Tunnel) {
        return Ok(match registry.handle_tunnel_rpc(&rpc.payload) {
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
    if matches!(rpc.method, ProtocolRpcMethod::Ports) {
        return handle_ports_rpc(request_id, rpc.payload, registry);
    }
    if matches!(rpc.method, ProtocolRpcMethod::Tabs) {
        return handle_tabs_rpc(request_id, rpc.payload, registry);
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
    // An explicit `headless: true` launch bypasses the desktop broker even while
    // a controller is connected, so callers (`pragma-cli agent verify`) can spawn
    // sessions without opening a desktop tab per launch.
    if control.method == pragma_constants::ControlMethod::AgentSessionLaunch
        && control
            .payload
            .get("headless")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    {
        return Err(headless_launch_control_result(registry, control.payload));
    }
    let Some(writer) = registry
        .controller_writer()
        .map_err(|err| HandledRequestError::Request(err.to_string()))?
    else {
        if control.method == pragma_constants::ControlMethod::AgentSessionLaunch {
            return Err(headless_launch_control_result(registry, control.payload));
        }
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

/// Runs a server-side (headless) agent session launch and wraps the outcome as
/// the control reply for the caller.
fn headless_launch_control_result(
    registry: &Registry,
    payload: serde_json::Value,
) -> HandledRequestError {
    match registry.launch_agent_headless(payload) {
        Ok(payload) => HandledRequestError::Control(ControlResult {
            ok: true,
            payload: Some(payload),
            error: None,
        }),
        Err(error) => HandledRequestError::Control(ControlResult {
            ok: false,
            payload: None,
            error: Some(error),
        }),
    }
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
    if matches!(subscription.event, ProtocolEventKind::AgentStatus) {
        let (scrollback, rx) = registry
            .subscribe_agent_status()
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
    writer: Arc<Mutex<LocalStream>>,
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
fn write_or_hang_up(writer: &Arc<Mutex<LocalStream>>, event: EventFrame) -> bool {
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
fn write_frame_or_hang_up(writer: &mut LocalStream, frame: &ServerFrame) -> bool {
    if write_json_frame(writer, frame).is_err() {
        let _ = writer.shutdown(Shutdown::Both);
        return false;
    }
    true
}

/// Writes one event to the client: output goes out as a binary frame (raw bytes,
/// no JSON escaping), while title/exit stay JSON control frames.
fn write_event(writer: &mut LocalStream, event: EventFrame) -> Result<(), ProtocolError> {
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
    /// Only read on Unix, where `daemonize` redirects the standard streams into
    /// it. On Windows the spawning client opens this same path itself and hands
    /// it to the new process — see `detach_spawned` in `pragma-client`.
    #[cfg_attr(not(unix), allow(dead_code))]
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
        socket: ipc::socket_path_in(&dir),
        lock: ipc::lock_path_in(&dir),
        log: ipc::log_path_in(&dir),
        dir,
    }
}

fn should_detach() -> bool {
    std::env::args_os().any(|arg| arg == OsStr::new(DETACH_FLAG))
}

fn should_relay() -> bool {
    std::env::args_os().any(|arg| arg == OsStr::new(RELAY_FLAG))
}

/// Copies this process's stdin and stdout to and from the server's socket,
/// then exits when either side closes.
///
/// This is how a Windows client reaches a server running inside WSL. WSL2 is a
/// virtual machine: it cannot connect to a Windows named pipe, and Windows
/// cannot connect to the Linux `AF_UNIX` socket inside it. What does cross the
/// boundary is a process launched through `wsl.exe`, whose standard streams are
/// ordinary pipes on the Windows side. So the Windows client runs this binary
/// inside the distribution with `--relay`, and gets a byte pipe to the socket.
///
/// Nothing is interpreted here — this is a pipe, and all framing stays in
/// `pragma-protocol`. Notably the socket keeps its owner-only permissions and
/// stays the only entry point, so agent plugins running inside the distribution
/// (`pragma-cli`, the opencode and Claude hooks) connect to it exactly as they
/// do on a native Linux host.
fn relay_stdio(socket: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::{Read, Write};

    let to_server = ipc::connect(socket).map_err(|error| {
        format!(
            "relay could not reach the server at {}: {error}",
            socket.display()
        )
    })?;
    let mut from_server = to_server.try_clone()?;

    // stdin -> socket on this thread, socket -> stdout on another: a relay is
    // full duplex, and a terminal is routinely writing and reading at once.
    let downstream = thread::spawn(move || {
        let mut stdout = std::io::stdout();
        let mut buffer = vec![0_u8; 32 * 1024];
        loop {
            match from_server.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if stdout.write_all(&buffer[..read]).is_err() || stdout.flush().is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut to_server = to_server;
    let mut stdin = std::io::stdin();
    let mut buffer = vec![0_u8; 32 * 1024];
    loop {
        match stdin.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if to_server.write_all(&buffer[..read]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = to_server.shutdown(Shutdown::Both);
    let _ = downstream.join();
    Ok(())
}

/// Detaches from the launching terminal so the server outlives it.
///
/// On Unix this forks, sets a new session, and redirects the standard streams
/// into the log file. Windows has no `fork`, and the equivalent is applied by
/// whoever spawns us instead: `pragma-client` creates the process with
/// `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW` and hands
/// it the log file as its stdout and stderr, so by the time this runs the
/// process is already detached and its output already redirected. See
/// `spawn_server` in `crates/pragma-client/src/lib.rs`.
#[cfg(unix)]
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
    daemonize::Daemonize::new()
        .working_directory(&paths.dir)
        .stdout(stdout)
        .stderr(stderr)
        .start()?;
    Ok(())
}

#[cfg(not(unix))]
fn detach_if_requested(
    paths: &ServerPaths,
    should_detach: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if !should_detach {
        return Ok(());
    }
    // The spawning side already detached us and redirected our output; all that
    // is left is the working directory `Daemonize` would have set.
    std::env::set_current_dir(&paths.dir)?;
    Ok(())
}

fn default_app_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        // Roaming application data is the Windows equivalent of the per-user
        // data directories used below, and is where Tauri puts the app's data.
        if let Some(app_data) = std::env::var_os("APPDATA") {
            return PathBuf::from(app_data).join("com.pragma.app");
        }
        std::env::var_os("USERPROFILE").map_or_else(std::env::temp_dir, |home| {
            PathBuf::from(home).join("AppData/Roaming/com.pragma.app")
        })
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var_os("HOME").map_or_else(std::env::temp_dir, PathBuf::from);
        if cfg!(target_os = "macos") {
            home.join("Library/Application Support/com.pragma.app")
        } else {
            home.join(".local/share/com.pragma.app")
        }
    }
}

/// Takes the single-server-per-channel lock, or fails if another server already
/// holds it.
///
/// This is a kernel advisory lock (`flock`) on the lock *file description*, not
/// the mere existence of the file. Existence-based locking was racy in a way
/// that let several servers run at once: a starting server that found a lock
/// file with no socket beside it yet would delete the winner's lock — a window
/// the winner is inside for its whole startup — and then take the lock itself.
/// Both then unlinked and rebound the socket, leaving orphaned servers holding
/// PTYs, watchers, and sidecars for the rest of the login session, each burning
/// its own share of the process fd budget.
///
/// An `flock` has neither problem: it is released automatically when the holder
/// exits (so a crash never leaves a stale lock needing cleanup), and it cannot
/// be stolen by unlinking the path. `daemonize` forks *before* this is called;
/// were that ever reordered, note that a lock taken pre-fork is shared with —
/// not re-acquired by — the child.
fn acquire_lock(lock_path: &Path) -> Result<File, Box<dyn std::error::Error>> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    file.try_lock().map_err(|err| {
        format!(
            "pragma-server is already running (lock held at {}): {err}",
            lock_path.display()
        )
    })?;
    Ok(file)
}

/// Clears the socket path for binding, refusing to start if a server is still
/// serving on it.
///
/// The lock and this check cover each other's blind spot. An advisory lock
/// guards a *file*, so anything that unlinks the lock path lets the next process
/// create a fresh file and lock that instead — no longer excluded by the holder.
/// A live socket is the evidence that survives: a server that is actually
/// serving still answers on it whatever happened to its lock file. Conversely a
/// socket file alone proves nothing (a killed server leaves one behind), which
/// is why a refused connection means "stale, unlink it" rather than "in use".
///
/// A deliberate replacement still works, because the app kills the old server
/// before spawning a new one (`kill_stale_server` in `pragma-client`) — by the
/// time we probe, nothing answers.
fn take_socket_path(socket: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if !socket.exists() {
        return Ok(());
    }
    if LocalStream::connect(socket).is_ok() {
        return Err(format!(
            "another pragma-server is already serving on {}",
            socket.display()
        )
        .into());
    }
    fs::remove_file(socket)?;
    Ok(())
}

// `remove_stale_files` used to probe the socket and delete a "stale" lock here.
// Both jobs are now handled by `acquire_lock`'s advisory lock, which the kernel
// releases on exit — see the race it removes, documented there.

#[cfg(test)]
mod tests {
    use std::thread;
    use std::time::{Duration, Instant};

    use super::{acquire_lock, take_socket_path};
    use pragma_platform::ipc::LocalListener;

    #[test]
    fn a_second_server_cannot_take_a_held_lock() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lock_path = dir.path().join("server.lock");

        let held = acquire_lock(&lock_path).expect("the first server takes the lock");
        assert!(
            acquire_lock(&lock_path).is_err(),
            "a second server must not run alongside the lock holder",
        );

        // Releasing hands the channel to the next server, exactly as process exit
        // does — no stale lock file to clean up first.
        //
        // Retried rather than asserted outright, because `cargo test` runs the
        // whole suite in one process and sibling tests spawn shells: a `fork` any
        // one of them makes while this lock is open briefly duplicates the fd, and
        // the lock outlives our `drop` until that child reaches `execve` and
        // O_CLOEXEC closes the copy. That is a test-harness artifact, not a
        // server one — in production the only process that forks while holding
        // this fd is the running server, which is exactly who should be blocking
        // us. (Verified separately: a PTY child does *not* keep the lock alive
        // past its exec, so session shells cannot pin a dead server's lock.)
        drop(held);
        let deadline = Instant::now() + Duration::from_secs(5);
        let next = loop {
            match acquire_lock(&lock_path) {
                Ok(lock) => break lock,
                Err(error) => assert!(
                    Instant::now() < deadline,
                    "the lock should be free once the holder exits: {error}",
                ),
            }
            thread::sleep(Duration::from_millis(10));
        };
        drop(next);
    }

    /// A server that is still serving must keep its socket even if its lock file
    /// was unlinked — the case an advisory lock alone cannot see, and the shape
    /// of the original bug: the deleted `remove_stale_files` removed a "stale"
    /// lock whose owner was mid-startup, after which both processes bound the
    /// socket and the loser kept running with PTYs, watchers, and sidecars.
    #[test]
    fn a_live_socket_blocks_a_second_server_even_with_no_lock_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket_path = dir.path().join("daemon.sock");
        let _serving = LocalListener::bind(&socket_path).expect("the first server binds");

        assert!(
            take_socket_path(&socket_path).is_err(),
            "a socket that still answers must not be unlinked and rebound",
        );
        assert!(
            socket_path.exists(),
            "the running server's socket must be left in place",
        );
    }

    /// The other half: a socket file with nobody behind it is debris from a
    /// killed server, and must not wedge startup forever.
    #[test]
    fn a_dead_socket_file_is_cleared_for_rebinding() {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket_path = dir.path().join("daemon.sock");
        std::fs::write(&socket_path, b"").expect("leave socket debris behind");

        take_socket_path(&socket_path).expect("a socket nobody answers on is stale");
        assert!(!socket_path.exists(), "the stale socket should be unlinked");
    }

    /// A leftover lock file must not block startup. The previous
    /// `create_new(true)` lock treated *any* existing file as a running server,
    /// so a crashed or `SIGKILL`ed server left a file that made every subsequent
    /// start fail until something deleted it — which is what motivated the
    /// stale-file cleanup that in turn caused the multi-server race.
    #[test]
    fn a_leftover_lock_file_from_a_dead_server_does_not_block_startup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lock_path = dir.path().join("server.lock");
        std::fs::write(&lock_path, "4242\n").expect("leave a lock file behind");

        let _lock = acquire_lock(&lock_path).expect("an unlocked leftover file is not a holder");
    }
}
