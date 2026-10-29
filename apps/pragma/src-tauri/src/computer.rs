//! Desktop side of computer use: the visible half of the safety model.
//!
//! The local host's `pragma-server` owns sessions, leases, policy, and the
//! native helper. This module forwards the desktop user's own requests (always
//! attributed as `user`, so approvals and the stop can only come from here),
//! bridges the `computerActivity` stream into the webviews, and owns the one
//! kind of window that must live outside the app: a transparent,
//! click-through overlay per display that draws the agent cursor over other
//! apps. Overlays are created hidden as soon as computer use is on and are
//! only shown while a session is live (see [`prepare_overlays`]). The
//! picture-in-picture view is an in-app panel in the main window, not a window.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use pragma_client::request_subscribe;
use pragma_constants::{
    ComputerActivitySnapshot, ComputerDisplay, ComputerScreenshot, ProtocolEventKind,
    ProtocolRpcMethod, CONSTANTS,
};
use pragma_protocol::{read_frame, write_json_frame, EventFrame, Frame, ServerFrame};
use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::error::{AppError, AppResult};
use crate::hosts::Hosts;
use crate::pty::PtyClient;

/// Frontend event carrying `{ kind: "snapshot" | "delta", payload }`.
const ACTIVITY_EVENT: &str = "pragma:computer";
/// Label prefix of the per-display cursor overlays.
const OVERLAY_PREFIX: &str = "computer-overlay-";

struct PreviewStream {
    id: String,
    stopped: Arc<AtomicBool>,
}
/// At most one active preview stream per desktop window.
#[derive(Clone, Default)]
pub struct ComputerPreviewStreams(Arc<Mutex<HashMap<String, PreviewStream>>>);
impl ComputerPreviewStreams {
    fn begin(&self, label: &str, id: &str) -> AppResult<Arc<AtomicBool>> {
        let stopped = Arc::new(AtomicBool::new(false));
        let previous = self
            .0
            .lock()
            .map_err(|_| AppError::InvalidInput("Preview stream unavailable".to_string()))?
            .insert(
                label.to_string(),
                PreviewStream {
                    id: id.to_string(),
                    stopped: Arc::clone(&stopped),
                },
            );
        if let Some(previous) = previous {
            previous.stopped.store(true, Ordering::SeqCst);
        }
        Ok(stopped)
    }
    fn stop(&self, label: &str, id: &str) {
        if let Ok(mut active) = self.0.lock() {
            if active.get(label).is_some_and(|s| s.id == id) {
                if let Some(stream) = active.remove(label) {
                    stream.stopped.store(true, Ordering::SeqCst);
                }
            }
        }
    }
}

/// Starts a bounded frame channel. Captures never run on the webview thread.
///
/// A failed capture is reported on `failures`, so
/// the panel can say why it has no frame — a missing Screen Recording grant
/// otherwise looks exactly like a slow first capture.
#[tauri::command]
pub fn computer_start_preview(
    hosts: State<'_, Hosts>,
    streams: State<'_, ComputerPreviewStreams>,
    window: WebviewWindow,
    session: String,
    max_width: u64,
    frames: tauri::ipc::Channel<ComputerScreenshot>,
    failures: tauri::ipc::Channel<String>,
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let streams = streams.inner().clone();
    let label = window.label().to_string();
    let stopped = streams.begin(&label, &id)?;
    let pty = hosts.local();
    let stream_id = id.clone();
    thread::spawn(move || {
        while !stopped.load(Ordering::SeqCst) {
            if window.is_visible().is_err() {
                break;
            }
            let result = pty.rpc(ProtocolRpcMethod::Computer,json!({"op":"frame","session":session,"maxWidth":max_width.clamp(1,CONSTANTS.computer.pip_expanded_frame_width.get()),"caller":{"kind":"user"}}))
                .and_then(|v|serde_json::from_value::<ComputerScreenshot>(v).map_err(AppError::from));
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            let delivered = match result {
                Ok(frame) => frames.send(frame),
                Err(error) => failures.send(error.to_string()),
            };
            if delivered.is_err() {
                break;
            }
            // A failed capture also backs off. Permission changes can recover without
            // remounting the panel, and captures never queue behind a slow one.
            thread::sleep(Duration::from_millis(
                CONSTANTS.computer.pip_frame_interval_ms.get(),
            ));
        }
        streams.stop(&label, &stream_id);
    });
    Ok(id)
}

/// Releases the caller window's exact preview generation.
#[tauri::command]
pub fn computer_stop_preview(
    streams: State<'_, ComputerPreviewStreams>,
    window: WebviewWindow,
    stream_id: String,
) {
    streams.stop(window.label(), &stream_id);
}

fn app_url(app: &AppHandle, fragment: &str) -> WebviewUrl {
    crate::updates::active_ui_overlay_url(app).map_or_else(
        || WebviewUrl::App(format!("index.html#{fragment}").into()),
        |mut url| {
            url.set_fragment(Some(fragment));
            WebviewUrl::External(url)
        },
    )
}

/// One `computer` RPC from the desktop user.
///
/// The caller is always overwritten with `user`: this command is the only
/// path that may approve a prompt, pause, or stop, and a payload must not be
/// able to claim to be anyone else.
#[tauri::command(async)]
pub fn computer_rpc(hosts: State<'_, Hosts>, mut payload: Value) -> AppResult<Value> {
    desktop_request(
        &mut payload,
        |payload| hosts.local().rpc(ProtocolRpcMethod::Computer, payload),
        |pid| Ok(pragma_platform::desktop::focus_app(pid)?),
    )
}

fn desktop_request(
    payload: &mut Value,
    rpc: impl Fn(Value) -> AppResult<Value>,
    focus: impl Fn(u64) -> AppResult<()>,
) -> AppResult<Value> {
    if !payload.is_object() {
        return Err(AppError::InvalidInput(
            "computer request must be an object".to_string(),
        ));
    }
    payload["caller"] = json!({ "kind": "user", "label": "You" });
    match rpc(payload.clone()) {
        Err(AppError::Daemon(message))
            if payload["op"] == "focusSession"
                && message.contains("invalid computer request")
                && message.contains("unknown variant `focusSession`") =>
        {
            // A persistent daemon can predate this control. Desktop navigation
            // needs no agent lease: use the host's live session instead of
            // issuing `focus` as a competing user session.
            let snapshot = serde_json::from_value(rpc(json!({
                "op": "status", "caller": { "kind": "user", "label": "You" }
            }))?)?;
            let pid = legacy_focus_pid(&snapshot, payload["session"].as_str())?;
            focus(pid)?;
            Ok(Value::Null)
        }
        result => result,
    }
}

fn legacy_focus_pid(snapshot: &ComputerActivitySnapshot, session: Option<&str>) -> AppResult<u64> {
    if !snapshot.enabled || snapshot.stopped || !snapshot.desktop_connected {
        return Err(AppError::InvalidInput(
            "computer use must be enabled, connected, and not stopped to focus an app".to_string(),
        ));
    }
    let session =
        session.ok_or_else(|| AppError::InvalidInput("a session id is required".into()))?;
    snapshot
        .sessions
        .iter()
        .find(|s| s.id == session)
        .and_then(|s| s.leases.last())
        .and_then(|lease| lease.pid)
        .ok_or_else(|| {
            AppError::InvalidInput("that session is not controlling a running app".into())
        })
}

/// Starts the activity bridge for the local host and registers the
/// emergency-stop shortcut.
pub fn start(app: AppHandle, pty: PtyClient) {
    thread::spawn(move || {
        let overlays = AtomicBool::new(false);
        loop {
            if let Err(error) = subscribe_once(&app, &pty, &overlays) {
                log::warn!("computer activity bridge disconnected: {error}");
                thread::sleep(Duration::from_millis(500));
            }
        }
    });
}

fn subscribe_once(app: &AppHandle, pty: &PtyClient, overlays: &AtomicBool) -> Result<(), String> {
    let mut stream = pty
        .connect_with_spawn()
        .map_err(|error| error.to_string())?;
    let request = request_subscribe(ProtocolEventKind::ComputerActivity, None, None);
    write_json_frame(&mut stream, &request).map_err(|error| error.to_string())?;
    let mut live_sessions: usize = 0;
    loop {
        let Frame::Json(bytes) = read_frame(&mut stream).map_err(|error| error.to_string())? else {
            continue;
        };
        match serde_json::from_slice::<ServerFrame>(&bytes) {
            Ok(ServerFrame::Response(response)) if response.request_id == request.request_id => {
                if !response.ok {
                    return Err(response
                        .error
                        .unwrap_or_else(|| "computer subscription rejected".to_string()));
                }
                // Mostly idle: the connect-time read timeout would read as a drop.
                stream
                    .set_read_timeout(None)
                    .map_err(|error| error.to_string())?;
            }
            Ok(ServerFrame::Event(EventFrame::Snapshot { payload, .. })) => {
                let snapshot =
                    serde_json::from_value::<ComputerActivitySnapshot>(payload.clone()).ok();
                live_sessions = snapshot.as_ref().map_or(0, |s| s.sessions.len());
                if snapshot.is_some_and(|s| s.enabled) && cursor_enabled(app) {
                    prepare_overlays(app);
                }
                sync_overlays(app, live_sessions > 0, overlays);
                let _ = app.emit(
                    ACTIVITY_EVENT,
                    json!({ "kind": "snapshot", "payload": payload }),
                );
            }
            Ok(ServerFrame::Event(EventFrame::Delta { payload, .. })) => {
                match payload["type"].as_str() {
                    Some("sessionStarted") => live_sessions += 1,
                    Some("sessionEnded") => live_sessions = live_sessions.saturating_sub(1),
                    _ => {}
                }
                sync_overlays(app, live_sessions > 0, overlays);
                let _ = app.emit(
                    ACTIVITY_EVENT,
                    json!({ "kind": "delta", "payload": payload }),
                );
            }
            _ => {}
        }
    }
}

/// Shows the overlays while any session is live, and hides them when the last
/// one ends.
fn sync_overlays(app: &AppHandle, wanted: bool, shown: &AtomicBool) {
    if wanted == shown.load(Ordering::SeqCst) {
        return;
    }
    if !wanted || !cursor_enabled(app) {
        shown.store(false, Ordering::SeqCst);
        for window in overlay_windows(app) {
            let _ = window.hide();
        }
        return;
    }
    // Also handles enabling computer use mid-run. The patched wry constructor
    // honors `.focused(false)` even when creating the first overlay.
    if overlay_windows(app).is_empty() {
        prepare_overlays(app);
    }
    let windows = overlay_windows(app);
    // Marked shown only once there is something to draw on: a failed display
    // read (the helper restarting) is retried on the next event instead of
    // leaving the session without a cursor.
    shown.store(!windows.is_empty(), Ordering::SeqCst);
    for window in windows {
        // Unfocusable, so this orders it in without activating Pragma.
        let _ = window.show();
    }
}

fn overlay_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(OVERLAY_PREFIX))
        .map(|(_, window)| window)
        .collect()
}

/// Makes sure there is one hidden, unfocusable overlay per display, at that
/// display's frame.
///
/// Preparing early has each overlay's activity bridge listening before the
/// first cursor move arrives. Late creation is safe too: the vendored wry
/// constructor respects `.focused(false)` on macOS, keeping the user's current
/// app and keyboard responder intact.
fn prepare_overlays(app: &AppHandle) {
    let displays: Vec<ComputerDisplay> = app
        .state::<Hosts>()
        .local()
        .rpc(
            ProtocolRpcMethod::Computer,
            json!({ "op": "displays", "caller": { "kind": "user" } }),
        )
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    if displays.is_empty() {
        return;
    }
    for (label, window) in app.webview_windows() {
        let index = label
            .strip_prefix(OVERLAY_PREFIX)
            .and_then(|index| index.parse::<usize>().ok());
        if index.is_some_and(|index| index >= displays.len()) {
            let _ = window.close();
        }
    }
    for (index, display) in displays.iter().enumerate() {
        let label = format!("{OVERLAY_PREFIX}{index}");
        let fragment = format!(
            "computer-overlay={}&x={}&y={}",
            urlencode(&display.id),
            display.frame.x,
            display.frame.y
        );
        if let Some(window) = app.get_webview_window(&label) {
            // The page reads its display's origin from the fragment once, at
            // load, so a rearranged display needs a reload (which, unlike a new
            // webview, activates nothing).
            if window
                .url()
                .is_ok_and(|url| url.fragment() != Some(fragment.as_str()))
            {
                let _ = window.eval(format!(
                    "location.hash = {}; location.reload();",
                    Value::String(fragment.clone())
                ));
            }
            let _ = window.set_position(LogicalPosition::new(display.frame.x, display.frame.y));
            let _ = window.set_size(LogicalSize::new(display.frame.w, display.frame.h));
            continue;
        }
        let built = WebviewWindowBuilder::new(app, &label, app_url(app, &fragment))
            .title("Computer use cursor")
            .position(display.frame.x, display.frame.y)
            .inner_size(display.frame.w, display.frame.h)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .visible(false)
            .focused(false)
            .focusable(false)
            .content_protected(true)
            .disable_drag_drop_handler()
            .build();
        match built {
            Ok(window) => {
                // Click-through: the overlay only ever draws.
                let _ = window.set_ignore_cursor_events(true);
            }
            Err(error) => log::warn!("could not open the computer-use overlay: {error}"),
        }
    }
}

/// `computerUse.showCursor` from the global config; on unless set to `false`.
fn cursor_enabled(app: &AppHandle) -> bool {
    let Ok(home) = app.path().home_dir() else {
        return true;
    };
    std::fs::read_to_string(home.join(&CONSTANTS.plugins.config_file_name))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|config| config["computerUse"]["showCursor"].as_bool())
        .unwrap_or(true)
}

fn urlencode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// The emergency-stop chord: ⌃⌥⌘. on macOS, Ctrl+Alt+Shift+Esc elsewhere.
pub fn emergency_stop_shortcut() -> &'static str {
    if cfg!(target_os = "macos") {
        "Control+Alt+Super+Period"
    } else {
        "Control+Alt+Shift+Escape"
    }
}

/// Runs the emergency stop against the local host.
pub fn emergency_stop(app: &AppHandle) {
    let result = app.state::<Hosts>().local().rpc(
        ProtocolRpcMethod::Computer,
        json!({ "op": "stop", "caller": { "kind": "user" } }),
    );
    if let Err(error) = result {
        log::warn!("computer-use emergency stop failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_ids_are_url_safe() {
        assert_eq!(urlencode("display:mac:5"), "display%3Amac%3A5");
    }

    fn old_host_snapshot() -> Value {
        json!({
            "enabled": true, "desktopConnected": true, "stopped": false, "lastSeq": 3,
            "approvals": [], "helper": { "state": "ready" },
            "sessions": [{
                "id": "cs_1", "owner": { "kind": "agentTab", "tabId": "t1" },
                "startedAt": 1, "lastActionAt": 2, "actionCount": 1, "paused": true,
                "leases": [
                    { "appKey": "first", "appName": "First", "pid": 101, "acquiredAt": 1 },
                    { "appKey": "preview", "appName": "Preview", "pid": 202, "acquiredAt": 2 }
                ]
            }]
        })
    }

    #[test]
    fn old_daemon_focus_uses_live_preview_pid_without_mutating_sessions() {
        let requests = std::cell::RefCell::new(Vec::new());
        let focused = std::cell::Cell::new(None);
        let mut payload = json!({"op":"focusSession", "session":"cs_1", "caller":{"kind":"sdk"}});
        desktop_request(
            &mut payload,
            |request| {
                requests.borrow_mut().push(request.clone());
                if request["op"] == "focusSession" {
                    Err(AppError::Daemon("rpc error InvalidPayload: invalid computer request: unknown variant `focusSession`".into()))
                } else {
                    Ok(old_host_snapshot())
                }
            },
            |pid| {
                focused.set(Some(pid));
                Ok(())
            },
        ).unwrap();
        assert_eq!(focused.get(), Some(202));
        let requests = requests.borrow();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1]["op"], "status");
        assert!(requests
            .iter()
            .all(|request| request["caller"]["kind"] == "user"));
    }

    #[test]
    fn session_focus_errors_other_than_unknown_operation_are_preserved() {
        for message in [
            "Stopped",
            "WindowNotFound",
            "NotAuthorized",
            "helperUnavailable",
        ] {
            let calls = std::cell::Cell::new(0);
            let result = desktop_request(
                &mut json!({"op":"focusSession", "session":"cs_1"}),
                |_| {
                    calls.set(calls.get() + 1);
                    Err(AppError::Daemon(message.into()))
                },
                |_| panic!("must not bypass a refused focus request"),
            );
            assert_eq!(
                result.unwrap_err().to_string(),
                format!("daemon error: {message}")
            );
            assert_eq!(calls.get(), 1);
        }
    }

    #[test]
    fn supported_daemon_focus_needs_no_fallback() {
        let result = desktop_request(
            &mut json!({"op":"focusSession", "session":"cs_1"}),
            |_| Ok(json!({"focused":true})),
            |_| panic!("the host already focused the app"),
        )
        .unwrap();
        assert_eq!(result, json!({"focused":true}));
    }

    #[test]
    fn legacy_focus_requires_an_enabled_live_session_but_allows_paused_sessions() {
        let snapshot: ComputerActivitySnapshot =
            serde_json::from_value(old_host_snapshot()).unwrap();
        assert_eq!(legacy_focus_pid(&snapshot, Some("cs_1")).unwrap(), 202);
        assert!(legacy_focus_pid(&snapshot, None).is_err());
        assert!(legacy_focus_pid(&snapshot, Some("missing")).is_err());
        for field in ["enabled", "desktopConnected", "stopped", "sessions"] {
            let mut value = old_host_snapshot();
            value[field] = match field {
                "stopped" => json!(true),
                "sessions" => json!([]),
                _ => json!(false),
            };
            let snapshot = serde_json::from_value(value).unwrap();
            assert!(legacy_focus_pid(&snapshot, Some("cs_1")).is_err());
        }
        let mut snapshot = snapshot;
        snapshot.sessions[0].leases.last_mut().unwrap().pid = None;
        assert!(legacy_focus_pid(&snapshot, Some("cs_1")).is_err());
    }
}

#[cfg(test)]
mod preview_tests {
    use super::*;
    #[test]
    fn replacing_a_preview_stops_the_old_generation_only() {
        let streams = ComputerPreviewStreams::default();
        let old = streams.begin("main", "old").unwrap();
        let current = streams.begin("main", "new").unwrap();
        assert!(old.load(Ordering::SeqCst));
        assert!(!current.load(Ordering::SeqCst));
        streams.stop("main", "old");
        assert!(!current.load(Ordering::SeqCst));
        streams.stop("main", "new");
        assert!(current.load(Ordering::SeqCst));
        assert!(streams.0.lock().unwrap().is_empty());
    }
    #[test]
    fn a_different_window_cannot_release_another_preview() {
        let streams = ComputerPreviewStreams::default();
        let flag = streams.begin("main", "id").unwrap();
        streams.stop("overlay", "id");
        assert!(!flag.load(Ordering::SeqCst));
        streams.stop("main", "id");
        assert!(flag.load(Ordering::SeqCst));
    }
}
