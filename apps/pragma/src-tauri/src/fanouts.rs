//! Thin fanout adapters: every call is forwarded to the host that owns the
//! project, which owns the durable record and the orchestration.
//!
//! There is deliberately no state and no sequencing here. The desktop is a
//! controller and a subscriber; a fanout runs identically with the app closed,
//! and duplicating any step of it on this side is how the two would drift.

use std::thread;
use std::time::Duration;

use pragma_client::request_subscribe;
use pragma_constants::{ProtocolEventKind, ProtocolRpcMethod};
use pragma_protocol::{read_frame, write_json_frame, EventFrame, Frame, ServerFrame};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::hosts::Hosts;
use crate::pty::PtyClient;

/// Frontend event carrying the host's full fanout set. v1 deltas are whole
/// replacements, so snapshot and delta emit the same shape.
const FANOUTS_EVENT: &str = "pragma:fanouts";

/// Forwards one `fanouts` RPC to a project's owning host.
///
/// `payload` is the shared discriminated request (`{ action, … }`) the CLI and
/// the SDK send, so the desktop cannot grow a dialect of its own.
#[tauri::command(async)]
pub fn fanout_rpc(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    project_id: String,
    payload: Value,
) -> AppResult<Value> {
    let client = hosts.for_project(&db, &project_id)?;
    client.rpc(ProtocolRpcMethod::Fanouts, payload)
}

/// Reads a project's current fanouts once, for a window that just opened.
#[tauri::command(async)]
pub fn list_fanouts(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    project_id: String,
) -> AppResult<Value> {
    let client = hosts.for_project(&db, &project_id)?;
    first_snapshot(&client).map_err(AppError::Daemon)
}

/// The destructive finalize, named explicitly so a caller cannot reach it by
/// assembling a generic payload.
#[tauri::command(async)]
pub fn pick_fanout_member(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    project_id: String,
    fanout_id: String,
    member_id: String,
) -> AppResult<Value> {
    let client = hosts.for_project(&db, &project_id)?;
    client.rpc(
        ProtocolRpcMethod::Fanouts,
        json!({ "action": "pick", "fanoutId": fanout_id, "memberId": member_id }),
    )
}

/// Starts a long-lived fanout subscription for one connected host client,
/// mirroring the agent-event bridge.
pub fn start_for(app: AppHandle, client: PtyClient) {
    thread::spawn(move || loop {
        if let Err(error) = subscribe_once(&app, &client) {
            log::warn!("fanout event bridge disconnected: {error}");
            thread::sleep(Duration::from_millis(500));
        }
    });
}

fn subscribe_once(app: &AppHandle, pty: &PtyClient) -> Result<(), String> {
    let mut stream = pty
        .connect_with_spawn()
        .map_err(|error| error.to_string())?;
    let request = request_subscribe(ProtocolEventKind::Fanouts, None, None);
    write_json_frame(&mut stream, &request).map_err(|error| error.to_string())?;
    loop {
        let Frame::Json(bytes) = read_frame(&mut stream).map_err(|error| error.to_string())? else {
            continue;
        };
        match serde_json::from_slice::<ServerFrame>(&bytes) {
            Ok(ServerFrame::Response(response)) if response.request_id == request.request_id => {
                if !response.ok {
                    return Err(response
                        .error
                        .unwrap_or_else(|| "fanout subscription rejected".to_string()));
                }
                // A subscription is mostly idle. Leaving the connect-time read
                // timeout on would make every quiet interval look like a
                // dropped connection and reconnect forever.
                stream
                    .set_read_timeout(None)
                    .map_err(|error| error.to_string())?;
            }
            Ok(ServerFrame::Event(
                EventFrame::Snapshot { payload, .. } | EventFrame::Delta { payload, .. },
            )) => {
                let _ = app.emit(FANOUTS_EVENT, payload);
                // The host creates the coordination parent and every attempt
                // worktree itself, so this bridge is the only signal the
                // desktop DB gets that they exist. Without a publish they are
                // never adopted and the sidebar shows no rows for the fanout.
                if let Some(publisher) =
                    app.try_state::<crate::workspace_mirror::WorkspacePublisher>()
                {
                    publisher.trigger();
                }
            }
            _ => {}
        }
    }
}

/// Opens a fanout subscription just long enough to read its snapshot.
///
/// There is deliberately no `list` RPC: the durable set is served by the
/// subscription, and a second read path would be a second source of truth.
pub(crate) fn first_snapshot(pty: &PtyClient) -> Result<Value, String> {
    let mut stream = pty
        .connect_with_spawn()
        .map_err(|error| error.to_string())?;
    let request = request_subscribe(ProtocolEventKind::Fanouts, None, None);
    write_json_frame(&mut stream, &request).map_err(|error| error.to_string())?;
    loop {
        let Frame::Json(bytes) = read_frame(&mut stream).map_err(|error| error.to_string())? else {
            continue;
        };
        match serde_json::from_slice::<ServerFrame>(&bytes) {
            Ok(ServerFrame::Event(EventFrame::Snapshot { payload, .. })) => return Ok(payload),
            Ok(ServerFrame::Response(response)) if !response.ok => {
                return Err(response
                    .error
                    .unwrap_or_else(|| "fanout subscription rejected".to_string()));
            }
            _ => {}
        }
    }
}
