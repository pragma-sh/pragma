use std::fs;
use std::path::Path;
use std::thread;
use std::time::Duration;

use pragma_client::request_subscribe;
use pragma_constants::{
    AutomationInfo, AutomationRootRegistration, FileContents, ProtocolEventKind, ProtocolRpcMethod,
};
use pragma_protocol::{read_frame, write_json_frame, EventFrame, Frame, ServerFrame};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::pty::PtyClient;

const AUTOMATION_PENDING_EVENT: &str = "pragma:automation-pending";
const AUTOMATIONS_CHANGED_EVENT: &str = "pragma:automations-changed";
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command(async)]
pub fn register_automation_roots(
    pty: tauri::State<'_, PtyClient>,
    projects: Vec<AutomationRootRegistration>,
) -> AppResult<()> {
    // The plugin catalog host shares the same project roots so it can resolve
    // project-scoped `.pragma/config.json` plugins. Best-effort: a plugins
    // failure must not break automation registration.
    let plugin_roots: Vec<String> = projects
        .iter()
        .map(|project| project.project_path.clone())
        .collect();
    let _ = pty.rpc(
        ProtocolRpcMethod::Plugins,
        json!({ "action": "registerRoots", "roots": plugin_roots }),
    );
    automation_rpc(
        &pty,
        json!({
            "action": "registerRoots",
            "projects": projects,
        }),
    )?;
    Ok(())
}

#[tauri::command(async)]
pub fn list_automations(pty: tauri::State<'_, PtyClient>) -> AppResult<Vec<AutomationInfo>> {
    let value = automation_rpc(&pty, json!({ "action": "list" }))?;
    serde_json::from_value(value).map_err(|error| AppError::Daemon(error.to_string()))
}

#[tauri::command(async)]
pub fn approve_automation(pty: tauri::State<'_, PtyClient>, id: String) -> AppResult<()> {
    automation_rpc(&pty, json!({ "action": "approve", "id": id }))?;
    Ok(())
}

#[tauri::command(async)]
pub fn reject_automation(pty: tauri::State<'_, PtyClient>, id: String) -> AppResult<()> {
    automation_rpc(&pty, json!({ "action": "reject", "id": id }))?;
    Ok(())
}

#[tauri::command(async)]
pub fn run_automation_now(pty: tauri::State<'_, PtyClient>, id: String) -> AppResult<()> {
    automation_rpc(&pty, json!({ "action": "runNow", "id": id }))?;
    Ok(())
}

/// Reads the `.ts` source file backing an automation from whichever host owns
/// the server socket. Used by the Automations workspace preview editor.
#[tauri::command(async)]
pub fn read_automation_source(
    pty: tauri::State<'_, PtyClient>,
    id: String,
) -> AppResult<FileContents> {
    match automation_rpc(&pty, json!({ "action": "readSource", "id": id })) {
        Ok(value) => {
            serde_json::from_value(value).map_err(|error| AppError::Daemon(error.to_string()))
        }
        Err(error) if unsupported_automation_action(&error, "readSource") => {
            read_source_path(automation_path(&pty, &id)?)
        }
        Err(error) => Err(error),
    }
}

/// Writes the `.ts` source file backing an automation on the owning host.
#[tauri::command(async)]
pub fn write_automation_source(
    pty: tauri::State<'_, PtyClient>,
    id: String,
    contents: String,
) -> AppResult<()> {
    match automation_rpc(
        &pty,
        json!({ "action": "writeSource", "id": id, "contents": contents.clone() }),
    ) {
        Ok(_) => Ok(()),
        Err(error) if unsupported_automation_action(&error, "writeSource") => {
            write_source_path(automation_path(&pty, &id)?, &contents)
        }
        Err(error) => Err(error),
    }
}

pub fn start(app: AppHandle, client: PtyClient) {
    let pending_app = app.clone();
    let pending_client = client.clone();
    thread::spawn(move || loop {
        if let Err(error) = subscribe_pending_once(&pending_app, &pending_client) {
            log::warn!("automation pending bridge disconnected: {error}");
            thread::sleep(Duration::from_millis(500));
        }
    });

    thread::spawn(move || loop {
        if let Err(error) = subscribe_changed_once(&app, &client) {
            log::warn!("automations changed bridge disconnected: {error}");
            thread::sleep(Duration::from_millis(500));
        }
    });
}

fn automation_rpc(pty: &PtyClient, payload: Value) -> AppResult<Value> {
    pty.rpc(ProtocolRpcMethod::Automations, payload)
}

fn unsupported_automation_action(error: &AppError, action: &str) -> bool {
    matches!(
        error,
        AppError::Daemon(message)
            if message.contains("unknown variant") && message.contains(action)
    )
}

fn automation_path(pty: &PtyClient, id: &str) -> AppResult<String> {
    let value = automation_rpc(pty, json!({ "action": "list" }))?;
    let automations: Vec<AutomationInfo> = serde_json::from_value(value)?;
    automations
        .into_iter()
        .find(|automation| automation.id == id)
        .map(|automation| automation.path)
        .ok_or_else(|| AppError::Daemon(format!("automation not found: {id}")))
}

fn read_source_path(path_string: String) -> AppResult<FileContents> {
    let path = Path::new(&path_string);
    let metadata = fs::metadata(path)?;
    let byte_size = metadata.len();
    if byte_size > MAX_SOURCE_BYTES {
        return Ok(FileContents {
            path: path_string,
            text: String::new(),
            binary: false,
            truncated: true,
            byte_size,
        });
    }
    let bytes = fs::read(path)?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileContents {
            path: path_string,
            text,
            binary: false,
            truncated: false,
            byte_size,
        }),
        Err(_) => Ok(FileContents {
            path: path_string,
            text: String::new(),
            binary: true,
            truncated: false,
            byte_size,
        }),
    }
}

fn write_source_path(path_string: String, contents: &str) -> AppResult<()> {
    fs::write(Path::new(&path_string), contents)?;
    Ok(())
}

fn subscribe_pending_once(app: &AppHandle, pty: &PtyClient) -> Result<(), String> {
    subscribe_once(
        app,
        pty,
        ProtocolEventKind::AutomationPending,
        |app, payload| {
            if let Ok(items) = serde_json::from_value::<Vec<AutomationInfo>>(payload.clone()) {
                for item in items {
                    let _ = app.emit(AUTOMATION_PENDING_EVENT, item);
                }
                return;
            }
            if let Some(automation) = payload.get("automation") {
                if let Ok(item) = serde_json::from_value::<AutomationInfo>(automation.clone()) {
                    let _ = app.emit(AUTOMATION_PENDING_EVENT, item);
                }
            }
        },
    )
}

fn subscribe_changed_once(app: &AppHandle, pty: &PtyClient) -> Result<(), String> {
    subscribe_once(
        app,
        pty,
        ProtocolEventKind::AutomationsChanged,
        |app, payload| {
            let value = payload
                .get("automations")
                .cloned()
                .unwrap_or_else(|| payload.clone());
            if let Ok(items) = serde_json::from_value::<Vec<AutomationInfo>>(value) {
                let _ = app.emit(AUTOMATIONS_CHANGED_EVENT, items);
            }
        },
    )
}

fn subscribe_once(
    app: &AppHandle,
    pty: &PtyClient,
    event: ProtocolEventKind,
    on_payload: impl Fn(&AppHandle, Value),
) -> Result<(), String> {
    let mut stream = pty
        .connect_with_spawn()
        .map_err(|error| error.to_string())?;
    let request = request_subscribe(event, None, None);
    write_json_frame(&mut stream, &request).map_err(|error| error.to_string())?;
    loop {
        match read_frame(&mut stream).map_err(|error| error.to_string())? {
            Frame::Json(bytes) => match serde_json::from_slice::<ServerFrame>(&bytes) {
                Ok(ServerFrame::Response(response))
                    if response.request_id == request.request_id =>
                {
                    if !response.ok {
                        return Err(response
                            .error
                            .unwrap_or_else(|| "automation subscription rejected".to_string()));
                    }
                }
                Ok(ServerFrame::Event(
                    EventFrame::Snapshot {
                        subscription,
                        payload,
                    }
                    | EventFrame::Delta {
                        subscription,
                        payload,
                    },
                )) if subscription == event => {
                    on_payload(app, payload);
                }
                Ok(
                    ServerFrame::Hello(_)
                    | ServerFrame::Response(_)
                    | ServerFrame::Rpc(_)
                    | ServerFrame::Control(_)
                    | ServerFrame::ControlResult(_)
                    | ServerFrame::Event(_),
                )
                | Err(_) => {}
            },
            Frame::Output { .. } | Frame::Input { .. } => {}
        }
    }
}
