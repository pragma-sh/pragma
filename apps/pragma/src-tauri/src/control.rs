//! Broker bridge between `pragma-cli` and the running Tauri app.
//!
//! The app registers as the single controller with `pragma-server`. CLI
//! commands publish `Control` requests to the server; the server forwards each
//! request to this bridge, which dispatches to the same Rust command logic the
//! UI already uses and returns a `ControlResult` tagged with the same
//! `request_id`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use pragma_constants::{
    ControlMethod, DiffSide, ProtocolRpcMethod, Tab, TabKind, Worktree, CONSTANTS,
};
use pragma_core::fs::FsRequest;
use pragma_core::git::GitRequest;
use pragma_core::tabs::TabsRequest;
use pragma_protocol::{
    read_json_frame, write_json_frame, ControlEnvelope, ControlResult, RequestFrame, RequestKind,
    ServerFrame,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::config_file::ensure_host_dir;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::fs::fs_rpc;
use crate::git::GitLocks;
use crate::hosts::{Hosts, LOCAL_HOST};
use crate::pty::PtyClient;
use crate::{browser, scripts, worktrees};

const CONTROL_RECONNECT_MS: u64 = 500;
const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 40;
const WORKTREE_CHANGED_EVENT: &str = "worktreeChanged";
const TABS_CHANGED_EVENT: &str = "tabsChanged";

#[derive(Clone)]
struct BrowserHistoryEntry {
    from: String,
    to: String,
}

#[derive(Default)]
struct BrowserHistoryState {
    back: HashMap<String, Vec<BrowserHistoryEntry>>,
    forward: HashMap<String, Vec<BrowserHistoryEntry>>,
}

/// Fallback history for brokered browser navigations that happen while a tab's
/// native webview is not mounted and therefore cannot receive a real history entry.
#[derive(Default)]
pub struct BrowserHistory(Mutex<BrowserHistoryState>);

impl BrowserHistory {
    fn record_offscreen_navigate(
        &self,
        tab_id: &str,
        previous_url: Option<&str>,
        next_url: &str,
    ) -> AppResult<()> {
        let mut state = self.0.lock()?;
        state.forward.remove(tab_id);
        let Some(previous_url) = previous_url else {
            return Ok(());
        };
        if previous_url == next_url {
            return Ok(());
        }
        state
            .back
            .entry(tab_id.to_string())
            .or_default()
            .push(BrowserHistoryEntry {
                from: previous_url.to_string(),
                to: next_url.to_string(),
            });
        Ok(())
    }

    fn back(&self, tab_id: &str, current_url: Option<&str>) -> AppResult<Option<String>> {
        let mut state = self.0.lock()?;
        let Some(stack) = state.back.get_mut(tab_id) else {
            return Ok(None);
        };
        let Some(entry) = stack.last() else {
            return Ok(None);
        };
        if current_url != Some(entry.to.as_str()) {
            return Ok(None);
        }
        let entry = stack.pop().expect("checked last entry");
        state
            .forward
            .entry(tab_id.to_string())
            .or_default()
            .push(BrowserHistoryEntry {
                from: entry.from.clone(),
                to: entry.to,
            });
        Ok(Some(entry.from))
    }

    fn forward(&self, tab_id: &str, current_url: Option<&str>) -> AppResult<Option<String>> {
        let mut state = self.0.lock()?;
        let Some(stack) = state.forward.get_mut(tab_id) else {
            return Ok(None);
        };
        let Some(entry) = stack.last() else {
            return Ok(None);
        };
        if current_url != Some(entry.from.as_str()) {
            return Ok(None);
        }
        let entry = stack.pop().expect("checked last entry");
        state
            .back
            .entry(tab_id.to_string())
            .or_default()
            .push(BrowserHistoryEntry {
                from: entry.from.clone(),
                to: entry.to.clone(),
            });
        Ok(Some(entry.to))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChangedEvent {
    action: &'static str,
    project_id: String,
    worktree_id: Option<String>,
    tab_id: Option<String>,
}

/// Starts the controller bridge.
pub fn start(app: AppHandle, pty: PtyClient, source_host_id: String) {
    thread::spawn(move || loop {
        if let Err(error) = register_once(&app, &pty, &source_host_id) {
            log::warn!("control bridge disconnected: {error}");
            thread::sleep(Duration::from_millis(CONTROL_RECONNECT_MS));
        }
    });
}

fn register_once(app: &AppHandle, pty: &PtyClient, source_host_id: &str) -> AppResult<()> {
    let mut stream = pty.connect_with_spawn()?;
    let request = RequestFrame {
        request_id: format!("controller-{}", std::process::id()),
        kind: RequestKind::RegisterController,
        session_id: None,
        worktree_id: None,
        cwd: None,
        cols: None,
        rows: None,
        data: None,
        rpc: None,
        subscription: None,
        control: None,
        control_result: None,
    };
    write_json_frame(&mut stream, &request)?;
    stream.set_read_timeout(None)?;
    loop {
        match read_json_frame::<ServerFrame>(&mut stream)? {
            ServerFrame::Response(response) if response.request_id == request.request_id => {
                if !response.ok {
                    return Err(AppError::Daemon(
                        response
                            .error
                            .unwrap_or_else(|| "controller registration rejected".to_string()),
                    ));
                }
                stream.set_read_timeout(None)?;
                // The server may have restarted while the app was running (its
                // workspace cache is in memory only). Republish the current
                // snapshot so remote subscribers like a paired phone see
                // projects/worktrees/tabs immediately after reconnect.
                if let Some(publisher) =
                    app.try_state::<crate::workspace_mirror::WorkspacePublisher>()
                {
                    publisher.trigger();
                }
            }
            ServerFrame::Control(envelope) => {
                let result = dispatch(app, envelope.clone(), source_host_id);
                let response = RequestFrame {
                    request_id: envelope.request_id,
                    kind: RequestKind::ControlResult,
                    session_id: None,
                    worktree_id: None,
                    cwd: None,
                    cols: None,
                    rows: None,
                    data: None,
                    rpc: None,
                    subscription: None,
                    control: None,
                    control_result: Some(result),
                };
                write_json_frame(&mut stream, &response)?;
            }
            ServerFrame::Hello(_)
            | ServerFrame::Rpc(_)
            | ServerFrame::Event(_)
            | ServerFrame::Response(_)
            | ServerFrame::ControlResult(_) => {}
        }
    }
}

fn dispatch(app: &AppHandle, envelope: ControlEnvelope, source_host_id: &str) -> ControlResult {
    match dispatch_inner(app, envelope.method, envelope.payload, source_host_id) {
        Ok(payload) => ControlResult {
            ok: true,
            payload: Some(payload),
            error: None,
        },
        Err(error) => ControlResult {
            ok: false,
            payload: None,
            error: Some(error.to_string()),
        },
    }
}

fn dispatch_inner(
    app: &AppHandle,
    method: ControlMethod,
    payload: serde_json::Value,
    source_host_id: &str,
) -> AppResult<serde_json::Value> {
    validate_control_source(app, source_host_id, &payload)?;
    match method {
        ControlMethod::WorktreesList => worktrees_list(app, payload),
        ControlMethod::WorktreeCreate => worktree_create(app, payload),
        ControlMethod::WorktreeRename => worktree_rename(app, payload),
        ControlMethod::WorktreeSetHidden => worktree_set_hidden(app, payload),
        ControlMethod::WorktreeDelete => worktree_delete(app, payload),
        ControlMethod::WorktreeStatus => worktree_status(app, payload),
        ControlMethod::TabsList => tabs_list(app, payload),
        ControlMethod::TabOpen => tab_open(app, payload),
        ControlMethod::TabClose => tab_close(app, payload),
        ControlMethod::TabRename => tab_rename(app, payload),
        ControlMethod::TabExec => tab_exec(app, payload),
        ControlMethod::SplitList => split_list(app, payload),
        ControlMethod::SplitSet => split_set(app, payload),
        ControlMethod::SplitAddTab => split_add_tab(app, payload),
        ControlMethod::SplitClear => split_clear(app, payload),
        ControlMethod::BrowserNavigate => browser_navigate(app, payload),
        ControlMethod::BrowserBack => browser_back(app, payload),
        ControlMethod::BrowserForward => browser_forward(app, payload),
        ControlMethod::BrowserReload => browser_reload(app, payload),
        ControlMethod::BrowserClose => browser_close(app, payload),
        ControlMethod::BrowserScroll => browser_scroll(app, payload),
        ControlMethod::BrowserFocus => browser_focus(app, payload),
        ControlMethod::BrowserClick => browser_click(app, payload),
        ControlMethod::BrowserEval => browser_eval(app, payload),
        ControlMethod::BrowserScreenshot => browser_screenshot(app, payload),
        ControlMethod::AgentStart => agent_start(app, payload),
        ControlMethod::AgentSessionLaunch => agent_session_launch(app, payload),
        ControlMethod::ScratchpadCreate => scratchpad_create(app, payload),
    }
}

/// Prevents a remote controller from targeting worktrees or tabs owned by another host.
fn validate_control_source(
    app: &AppHandle,
    source_host_id: &str,
    payload: &serde_json::Value,
) -> AppResult<()> {
    if source_host_id == LOCAL_HOST {
        return Ok(());
    }
    let mut worktree_ids = ["worktreeId", "parentWorktreeId"]
        .into_iter()
        .filter_map(|key| payload.get(key).and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if let Some(parent) = payload
        .get("newWorktree")
        .and_then(|value| value.get("parentWorktreeId"))
        .and_then(serde_json::Value::as_str)
    {
        worktree_ids.push(parent.to_string());
    }
    for key in ["tabId", "agentTabId"] {
        if let Some(tab_id) = payload.get(key).and_then(serde_json::Value::as_str) {
            worktree_ids.push(resolve_tab(app, tab_id)?.worktree_id);
        }
    }
    if worktree_ids.is_empty() {
        return Err(AppError::InvalidInput(
            "remote control request has no host-scoped worktree or tab".to_string(),
        ));
    }
    let db = app.state::<Db>();
    let hosts = app.state::<Hosts>();
    for worktree_id in worktree_ids {
        let owner = hosts.host_id_for_worktree(&db, &worktree_id)?;
        if owner != source_host_id {
            return Err(AppError::InvalidInput(format!(
                "remote control request cannot target worktree {worktree_id} on host {owner}"
            )));
        }
    }
    Ok(())
}

fn parse<T: for<'de> Deserialize<'de>>(payload: serde_json::Value) -> AppResult<T> {
    serde_json::from_value(payload).map_err(AppError::from)
}

fn json<T: serde::Serialize>(value: T) -> AppResult<serde_json::Value> {
    serde_json::to_value(value).map_err(AppError::from)
}

fn emit_worktree_changed(
    app: &AppHandle,
    action: &'static str,
    project_id: String,
    worktree_id: Option<String>,
) {
    let _ = app.emit(
        WORKTREE_CHANGED_EVENT,
        WorkspaceChangedEvent {
            action,
            project_id,
            worktree_id,
            tab_id: None,
        },
    );
}

fn emit_tabs_changed(app: &AppHandle, action: &'static str, tab: &pragma_constants::Tab) {
    let _ = app.emit(
        TABS_CHANGED_EVENT,
        WorkspaceChangedEvent {
            action,
            project_id: tab.project_id.clone(),
            worktree_id: Some(tab.worktree_id.clone()),
            tab_id: Some(tab.id.clone()),
        },
    );
}

fn emit_split_changed(app: &AppHandle, project_id: &str, worktree_id: &str) {
    let _ = app.emit(
        TABS_CHANGED_EVENT,
        WorkspaceChangedEvent {
            action: "splitChanged",
            project_id: project_id.to_string(),
            worktree_id: Some(worktree_id.to_string()),
            tab_id: None,
        },
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeIdPayload {
    worktree_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptionalWorktreePayload {
    worktree_id: Option<String>,
}

fn project_from_worktree(app: &AppHandle, worktree_id: &str) -> AppResult<String> {
    Ok(app.state::<Db>().worktree(worktree_id)?.project_id)
}

fn worktrees_list(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: OptionalWorktreePayload = parse(payload)?;
    let id = args
        .worktree_id
        .ok_or_else(|| AppError::InvalidInput("worktreeId is required".to_string()))?;
    let project_id = project_from_worktree(app, &id)?;
    json(worktrees::list_worktrees(app.state::<Db>(), project_id)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeCreatePayload {
    parent_worktree_id: String,
    branch: String,
    title: Option<String>,
}

fn worktree_create(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: WorktreeCreatePayload = parse(payload)?;
    let project_id = project_from_worktree(app, &args.parent_worktree_id)?;
    let worktree = worktrees::create_worktree(
        app.state::<Db>(),
        app.state::<Hosts>(),
        app.state::<GitLocks>(),
        app.state::<crate::workspace_mirror::WorkspacePublisher>(),
        project_id.clone(),
        args.parent_worktree_id,
        args.branch,
        args.title,
    )?;
    emit_worktree_changed(
        app,
        "worktreeCreated",
        project_id,
        Some(worktree.id.clone()),
    );
    json(worktree)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenamePayload {
    worktree_id: String,
    title: Option<String>,
}

fn worktree_rename(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: RenamePayload = parse(payload)?;
    let worktree = worktrees::rename_worktree(
        args.worktree_id,
        args.title,
        app.state::<Db>(),
        app.state::<crate::workspace_mirror::WorkspacePublisher>(),
    )?;
    emit_worktree_changed(
        app,
        "worktreeRenamed",
        worktree.project_id.clone(),
        Some(worktree.id.clone()),
    );
    json(worktree)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HiddenPayload {
    worktree_id: String,
    hidden: bool,
}

fn worktree_set_hidden(
    app: &AppHandle,
    payload: serde_json::Value,
) -> AppResult<serde_json::Value> {
    let args: HiddenPayload = parse(payload)?;
    let worktree = worktrees::hide_worktree(
        args.worktree_id,
        args.hidden,
        app.state::<Db>(),
        app.state::<crate::workspace_mirror::WorkspacePublisher>(),
    )?;
    emit_worktree_changed(
        app,
        "worktreeHiddenChanged",
        worktree.project_id.clone(),
        Some(worktree.id.clone()),
    );
    json(worktree)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeletePayload {
    worktree_id: String,
    delete_branch: bool,
    force: bool,
}

fn worktree_delete(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: DeletePayload = parse(payload)?;
    let worktree = app.state::<Db>().worktree(&args.worktree_id)?;
    worktrees::delete_worktree(
        app.clone(),
        args.worktree_id,
        args.delete_branch,
        args.force,
    )?;
    emit_worktree_changed(
        app,
        "worktreeDeleted",
        worktree.project_id,
        Some(worktree.id),
    );
    json(serde_json::json!({ "ok": true }))
}

fn worktree_status(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: WorktreeIdPayload = parse(payload)?;
    json(worktrees::worktree_status(
        args.worktree_id,
        app.state::<Db>(),
        app.state::<Hosts>(),
    )?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabsListPayload {
    worktree_id: Option<String>,
    all: bool,
}

fn tabs_list(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: TabsListPayload = parse(payload)?;
    let id = args
        .worktree_id
        .ok_or_else(|| AppError::InvalidInput("worktreeId is required".to_string()))?;
    let project_id = project_from_worktree(app, &id)?;
    let tabs = app.state::<Db>().list_tabs(&project_id)?;
    if args.all {
        json(tabs)
    } else {
        json(
            tabs.into_iter()
                .filter(|tab| tab.worktree_id == id)
                .collect::<Vec<_>>(),
        )
    }
}

fn resolve_tab(app: &AppHandle, tab_id: &str) -> AppResult<Tab> {
    app.state::<Db>().tab_by_id_or_prefix(tab_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabOpenPayload {
    worktree_id: String,
    kind: String,
    title: Option<String>,
    command: Option<String>,
    url: Option<String>,
    file: Option<String>,
    diff_side: Option<String>,
}

fn tab_open(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: TabOpenPayload = parse(payload)?;
    let worktree = app.state::<Db>().worktree(&args.worktree_id)?;
    let kind = tab_kind(&args.kind)?;
    let tab = app.state::<Db>().create_tab(
        &worktree.project_id,
        &worktree.id,
        kind,
        args.title,
        args.url.clone(),
        args.file.clone(),
        args.diff_side.as_deref().map(diff_side).transpose()?,
        None,
        None,
    )?;
    if matches!(kind, TabKind::Terminal) {
        let pty = app
            .state::<Hosts>()
            .for_worktree(app.state::<Db>().inner(), &worktree.id)?;
        pty.spawn_detached(
            tab.id.clone(),
            worktree.id.clone(),
            worktree.path.clone(),
            DEFAULT_COLS,
            DEFAULT_ROWS,
        )?;
        if let Some(command) = args.command {
            let _ = pty.write(tab.id.clone(), format!("{command}\r"));
        }
    }
    emit_tabs_changed(app, "tabOpened", &tab);
    app.state::<crate::workspace_mirror::WorkspacePublisher>()
        .trigger();
    json(tab)
}

fn tab_close(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: TabIdPayload = parse(payload)?;
    let tab = resolve_tab(app, &args.tab_id)?;
    match tab.kind {
        TabKind::Terminal => {
            let db = app.state::<Db>();
            let hosts = app.state::<Hosts>();
            if let Ok(client) = hosts.for_worktree(&db, &tab.worktree_id) {
                let _ = client.kill(tab.id.clone());
            }
            let _ = hosts.unbind_session(&tab.id);
        }
        TabKind::Browser => {
            browser::browser_close(app.clone(), tab.id.clone())?;
        }
        TabKind::Editor
        | TabKind::Diff
        | TabKind::PrReview
        | TabKind::Log
        | TabKind::PluginWebview
        | TabKind::Scratchpad => {}
    }
    app.state::<Db>().delete_tab(&tab.id)?;
    emit_tabs_changed(app, "tabClosed", &tab);
    app.state::<crate::workspace_mirror::WorkspacePublisher>()
        .trigger();
    json(serde_json::json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabRenamePayload {
    tab_id: String,
    title: String,
}

fn tab_rename(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: TabRenamePayload = parse(payload)?;
    let tab = resolve_tab(app, &args.tab_id)?;
    let tab = app.state::<Db>().rename_tab(&tab.id, &args.title)?;
    emit_tabs_changed(app, "tabRenamed", &tab);
    app.state::<crate::workspace_mirror::WorkspacePublisher>()
        .trigger();
    json(tab)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabExecPayload {
    worktree_id: String,
    command: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    command: String,
    stdout: String,
    stderr: String,
    status: Option<i32>,
}

fn tab_exec(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: TabExecPayload = parse(payload)?;
    let db = app.state::<Db>();
    let worktree = db.worktree(&args.worktree_id)?;
    let project = db.project(&worktree.project_id)?;
    let pty = app.state::<Hosts>().for_worktree(&db, &args.worktree_id)?;
    let command = shell_join(&args.command);
    let result = scripts::run_headless_command(&pty, &project, &worktree, &command)?;
    json(ExecResult {
        command: result.command,
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScratchpadCreatePayload {
    worktree_id: String,
    agent_tab_id: String,
    title: String,
    contents: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScratchpadMetadata<'a> {
    version: u64,
    id: &'a str,
    title: &'a str,
    agent_tab_id: &'a str,
    agent_id: &'a str,
    created_at: u64,
}

fn scratchpad_create(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: ScratchpadCreatePayload = parse(payload)?;
    let title = args.title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidInput(
            "scratchpad title cannot be empty".to_string(),
        ));
    }
    let db = app.state::<Db>();
    let worktree = db.worktree(&args.worktree_id)?;
    let agent_tab = resolve_tab(app, &args.agent_tab_id)?;
    if agent_tab.worktree_id != worktree.id || !matches!(agent_tab.kind, TabKind::Terminal) {
        return Err(AppError::InvalidInput(
            "scratchpad creator must be a terminal tab in the current worktree".to_string(),
        ));
    }
    let client = app.state::<Hosts>().for_worktree(&db, &worktree.id)?;
    let agent_id = crate::scratchpads::registered_agent_id(&client, &agent_tab)?;
    let id = Uuid::new_v4().to_string();
    let path = format!(
        "{}/{}-{}.{}",
        CONSTANTS.scratchpads.directory,
        scratchpad_slug(title),
        &id[..8],
        CONSTANTS.scratchpads.extension
    );
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| AppError::InvalidInput(format!("system clock is before epoch: {error}")))?
        .as_secs();
    let metadata = ScratchpadMetadata {
        version: CONSTANTS.scratchpads.version.get(),
        id: &id,
        title,
        agent_tab_id: &agent_tab.id,
        agent_id: &agent_id,
        created_at,
    };
    let document = scratchpad_document(&args.contents, &metadata)?;
    client.rpc(
        ProtocolRpcMethod::Git,
        serde_json::to_value(GitRequest::EnsurePragmaExcluded {
            project_root: worktree.path.clone(),
        })?,
    )?;
    ensure_host_dir(&client, &worktree.path, &CONSTANTS.scratchpads.directory)?;
    fs_rpc::<()>(
        &client,
        &FsRequest::WriteFile {
            root: worktree.path.clone(),
            path: path.clone(),
            contents: document,
        },
    )?;
    let tab = match db.create_tab(
        &worktree.project_id,
        &worktree.id,
        TabKind::Scratchpad,
        Some(title.to_string()),
        None,
        Some(path.clone()),
        None,
        None,
        None,
    ) {
        Ok(tab) => tab,
        Err(error) => {
            let _ = fs_rpc::<()>(
                &client,
                &FsRequest::Delete {
                    root: worktree.path,
                    path,
                },
            );
            return Err(error);
        }
    };
    emit_tabs_changed(app, "tabOpened", &tab);
    app.state::<crate::workspace_mirror::WorkspacePublisher>()
        .trigger();
    json(tab)
}

fn scratchpad_slug(title: &str) -> String {
    let mut slug = String::new();
    let mut separated = false;
    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            if slug.len() < 64 {
                slug.push(character.to_ascii_lowercase());
            }
            separated = false;
        } else if slug.len() < 64 && !separated && !slug.is_empty() {
            slug.push('-');
            separated = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "scratchpad".to_string()
    } else {
        slug
    }
}

fn scratchpad_document(source: &str, metadata: &ScratchpadMetadata<'_>) -> AppResult<String> {
    let metadata = serde_json::to_string(metadata)?;
    let entry = format!("{}: {metadata}", CONSTANTS.scratchpads.frontmatter_key);
    if let Some(rest) = source.strip_prefix("---\n") {
        return Ok(format!("---\n{entry}\n{rest}"));
    }
    if let Some(rest) = source.strip_prefix("---\r\n") {
        return Ok(format!("---\n{entry}\n{rest}"));
    }
    Ok(format!("---\n{entry}\n---\n\n{source}"))
}

fn split_list(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: OptionalWorktreePayload = parse(payload)?;
    let id = args
        .worktree_id
        .ok_or_else(|| AppError::InvalidInput("worktreeId is required".to_string()))?;
    let project_id = project_from_worktree(app, &id)?;
    json(app.state::<Db>().list_splits(&project_id)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitSetPayload {
    worktree_id: String,
    layout: String,
}

fn split_set(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: SplitSetPayload = parse(payload)?;
    let worktree = app.state::<Db>().worktree(&args.worktree_id)?;
    let spec: CliSplitNode = serde_json::from_str(&args.layout).map_err(AppError::from)?;
    let root = materialize_cli_split(app, &worktree, spec)?;
    let layout = serde_json::to_string(&root).map_err(AppError::from)?;
    app.state::<Db>()
        .set_split_layout(&args.worktree_id, &layout)?;
    emit_split_changed(app, &worktree.project_id, &worktree.id);
    json(serde_json::json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitAddTabPayload {
    worktree_id: String,
    add_tab: SplitAddTabSpec,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitAddTabSpec {
    side: String,
    #[serde(flatten)]
    tab: SplitTabSpec,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitTabSpec {
    kind: String,
    command: Option<String>,
    url: Option<String>,
    file: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CliSplitNode {
    Leaf(SplitTabSpec),
    Horizontal {
        left: Box<CliSplitNode>,
        right: Box<CliSplitNode>,
    },
    Vertical {
        top: Box<CliSplitNode>,
        bottom: Box<CliSplitNode>,
    },
}

fn split_add_tab(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: SplitAddTabPayload = parse(payload)?;
    let worktree = app.state::<Db>().worktree(&args.worktree_id)?;
    let existing_root = current_split_root(app, &worktree)?;
    let side = args.add_tab.side;
    validate_split_side(&side)?;
    let new_pane = materialize_split_tab(app, &worktree, args.add_tab.tab)?;
    let root = match existing_root {
        Some(existing) => graft_split(&side, existing, new_pane)?,
        None => new_pane,
    };
    let layout = serde_json::to_string(&root).map_err(AppError::from)?;
    app.state::<Db>().set_split_layout(&worktree.id, &layout)?;
    emit_split_changed(app, &worktree.project_id, &worktree.id);
    json(serde_json::json!({ "ok": true }))
}

fn validate_split_side(side: &str) -> AppResult<()> {
    match side {
        "left" | "right" | "top" | "bottom" => Ok(()),
        other => Err(AppError::InvalidInput(format!(
            "unknown split side: {other}"
        ))),
    }
}

fn materialize_cli_split(
    app: &AppHandle,
    worktree: &Worktree,
    node: CliSplitNode,
) -> AppResult<serde_json::Value> {
    match node {
        CliSplitNode::Leaf(spec) => materialize_split_tab(app, worktree, spec),
        CliSplitNode::Horizontal { left, right } => Ok(split_json(
            "horizontal",
            materialize_cli_split(app, worktree, *left)?,
            materialize_cli_split(app, worktree, *right)?,
        )),
        CliSplitNode::Vertical { top, bottom } => Ok(split_json(
            "vertical",
            materialize_cli_split(app, worktree, *top)?,
            materialize_cli_split(app, worktree, *bottom)?,
        )),
    }
}

fn materialize_split_tab(
    app: &AppHandle,
    worktree: &Worktree,
    spec: SplitTabSpec,
) -> AppResult<serde_json::Value> {
    let kind = tab_kind(&spec.kind)?;
    if matches!(kind, TabKind::PrReview) {
        return Err(AppError::InvalidInput(
            "split tabs cannot create pr-review tabs without a pull request number".to_string(),
        ));
    }
    let diff_side = matches!(kind, TabKind::Diff).then_some(DiffSide::Worktree);
    let tab = app.state::<Db>().create_tab(
        &worktree.project_id,
        &worktree.id,
        kind,
        None,
        spec.url.clone(),
        spec.file.clone(),
        diff_side,
        None,
        None,
    )?;
    if matches!(kind, TabKind::Terminal) {
        let pty = app
            .state::<Hosts>()
            .for_worktree(app.state::<Db>().inner(), &worktree.id)?;
        pty.spawn_detached(
            tab.id.clone(),
            worktree.id.clone(),
            worktree.path.clone(),
            DEFAULT_COLS,
            DEFAULT_ROWS,
        )?;
        if let Some(command) = spec.command {
            let _ = pty.write(tab.id.clone(), format!("{command}\r"));
        }
    }
    Ok(pane_json(&tab))
}

fn current_split_root(
    app: &AppHandle,
    worktree: &Worktree,
) -> AppResult<Option<serde_json::Value>> {
    let split = app
        .state::<Db>()
        .list_splits(&worktree.project_id)?
        .into_iter()
        .find(|record| record.worktree_id == worktree.id);
    if let Some(record) = split {
        return serde_json::from_str(&record.layout)
            .map(Some)
            .map_err(AppError::from);
    }
    let tab_ids = app
        .state::<Db>()
        .list_tabs(&worktree.project_id)?
        .into_iter()
        .filter(|tab| tab.worktree_id == worktree.id)
        .map(|tab| tab.id)
        .collect::<Vec<_>>();
    if tab_ids.is_empty() {
        Ok(None)
    } else {
        let active_tab_id = tab_ids.first().cloned();
        Ok(Some(serde_json::json!({
            "kind": "pane",
            "id": format!("pane-{}", Uuid::new_v4()),
            "tabIds": tab_ids,
            "activeTabId": active_tab_id,
        })))
    }
}

fn graft_split(
    side: &str,
    existing: serde_json::Value,
    new_pane: serde_json::Value,
) -> AppResult<serde_json::Value> {
    match side {
        "left" => Ok(split_json("horizontal", new_pane, existing)),
        "right" => Ok(split_json("horizontal", existing, new_pane)),
        "top" => Ok(split_json("vertical", new_pane, existing)),
        "bottom" => Ok(split_json("vertical", existing, new_pane)),
        other => Err(AppError::InvalidInput(format!(
            "unknown split side: {other}"
        ))),
    }
}

fn split_json(
    direction: &str,
    first: serde_json::Value,
    second: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "kind": "split",
        "id": format!("split-{}", Uuid::new_v4()),
        "direction": direction,
        "children": [first, second],
    })
}

fn pane_json(tab: &Tab) -> serde_json::Value {
    serde_json::json!({
        "kind": "pane",
        "id": format!("pane-{}", Uuid::new_v4()),
        "tabIds": [tab.id],
        "activeTabId": tab.id,
    })
}

fn split_clear(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: WorktreeIdPayload = parse(payload)?;
    let worktree = app.state::<Db>().worktree(&args.worktree_id)?;
    app.state::<Db>().clear_split_layout(&args.worktree_id)?;
    emit_split_changed(app, &worktree.project_id, &worktree.id);
    json(serde_json::json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabIdPayload {
    tab_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNavigatePayload {
    tab_id: String,
    url: String,
}

fn browser_navigate(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: BrowserNavigatePayload = parse(payload)?;
    let url = browser::parse_url(&args.url)?.to_string();
    let tab = resolve_tab(app, &args.tab_id)?;
    if !matches!(tab.kind, TabKind::Browser) {
        return Err(AppError::InvalidInput(format!(
            "tab {} is not a browser tab",
            tab.id
        )));
    }
    let had_webview = browser::has_webview(app, &tab.id);
    let previous_url = tab.url.clone();
    let tab = app.state::<Db>().set_tab_url(&tab.id, &url)?;
    browser::browser_navigate(app.clone(), tab.id.clone(), url)?;
    if !had_webview {
        app.state::<BrowserHistory>().record_offscreen_navigate(
            &tab.id,
            previous_url.as_deref(),
            tab.url.as_deref().unwrap_or_default(),
        )?;
    }
    emit_tabs_changed(app, "tabUpdated", &tab);
    json(serde_json::json!({ "ok": true }))
}

fn browser_back(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: TabIdPayload = parse(payload)?;
    let tab = resolve_tab(app, &args.tab_id)?;
    if let Some(url) = app
        .state::<BrowserHistory>()
        .back(&tab.id, tab.url.as_deref())?
    {
        let tab = app.state::<Db>().set_tab_url(&tab.id, &url)?;
        browser::browser_navigate(app.clone(), tab.id.clone(), url)?;
        emit_tabs_changed(app, "tabUpdated", &tab);
    } else {
        browser::browser_back(app.clone(), tab.id)?;
    }
    json(serde_json::json!({ "ok": true }))
}

fn browser_forward(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: TabIdPayload = parse(payload)?;
    let tab = resolve_tab(app, &args.tab_id)?;
    if let Some(url) = app
        .state::<BrowserHistory>()
        .forward(&tab.id, tab.url.as_deref())?
    {
        let tab = app.state::<Db>().set_tab_url(&tab.id, &url)?;
        browser::browser_navigate(app.clone(), tab.id.clone(), url)?;
        emit_tabs_changed(app, "tabUpdated", &tab);
    } else {
        browser::browser_forward(app.clone(), tab.id)?;
    }
    json(serde_json::json!({ "ok": true }))
}

fn browser_reload(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: TabIdPayload = parse(payload)?;
    let tab = resolve_tab(app, &args.tab_id)?;
    browser::browser_reload(app.clone(), tab.id)?;
    json(serde_json::json!({ "ok": true }))
}

fn browser_close(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: TabIdPayload = parse(payload)?;
    let tab = resolve_tab(app, &args.tab_id)?;
    browser::browser_close(app.clone(), tab.id)?;
    json(serde_json::json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserScrollPayload {
    tab_id: String,
    x: i64,
    y: i64,
    to: Option<String>,
}

fn browser_scroll(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: BrowserScrollPayload = parse(payload)?;
    let tab = resolve_tab(app, &args.tab_id)?;
    browser::browser_scroll(app.clone(), tab.id, args.x, args.y, args.to)?;
    json(serde_json::json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectorPayload {
    tab_id: String,
    selector: String,
}

fn browser_focus(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: SelectorPayload = parse(payload)?;
    let tab = resolve_tab(app, &args.tab_id)?;
    browser::browser_focus_element(app.clone(), tab.id, args.selector)?;
    json(serde_json::json!({ "ok": true }))
}

fn browser_click(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: SelectorPayload = parse(payload)?;
    let tab = resolve_tab(app, &args.tab_id)?;
    browser::browser_click(app.clone(), tab.id, args.selector)?;
    json(serde_json::json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserEvalPayload {
    tab_id: String,
    script: String,
}

fn browser_eval(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: BrowserEvalPayload = parse(payload)?;
    let tab = resolve_tab(app, &args.tab_id)?;
    let result = browser::browser_eval(app.clone(), tab.id, args.script)?;
    json(serde_json::json!({ "result": result }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserScreenshotPayload {
    tab_id: String,
    out: Option<String>,
}

fn browser_screenshot(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: BrowserScreenshotPayload = parse(payload)?;
    let tab = resolve_tab(app, &args.tab_id)?;
    browser::browser_screenshot_tab(app.clone(), tab.id, args.out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentStartPayload {
    worktree_id: String,
    agent: String,
    model: Option<String>,
    prompt: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartResult {
    tab_id: String,
}

fn agent_start(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: AgentStartPayload = parse(payload)?;
    json(start_agent(
        app.clone(),
        app.state::<Db>(),
        app.state::<PtyClient>(),
        args.worktree_id,
        args.agent,
        args.model,
        args.prompt,
    )?)
}

/// Reply payload for {@link `agent_session_launch`}: the resolved/created worktree
/// and tab the frontend should launch the agent into.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionLaunchResult {
    worktree_id: String,
    tab_id: String,
}

/// Payload for the brokered `agentSessionLaunch` control method (schema
/// `AgentSessionLaunchPayload`). Either `worktreeId` (an existing worktree) or
/// `newWorktree` (a fresh-worktree spec) must be provided.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionLaunchArgs {
    project_id: String,
    worktree_id: Option<String>,
    new_worktree: Option<NewWorktreeArgs>,
    agent_id: String,
    model_id: Option<String>,
    reasoning_id: Option<String>,
    /// Raw model command snippet (for example `--model moonshot/kimi-k3`)
    /// appended to the base launch command instead of catalog model args.
    model_cmd: Option<String>,
    prompt: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewWorktreeArgs {
    parent_worktree_id: String,
    branch: String,
    title: Option<String>,
}

/// Handles `agentSessionLaunch`: resolves or creates the target worktree and a
/// new terminal tab, replies `{ worktreeId, tabId }`, and emits the
/// `pragma:agent-session-launch` Tauri event so the frontend runs the proven
/// Kanban background-launch sequence (`startBackgroundAgentSession`). The reply
/// is immediate; the PTY spawn + agent launch happen asynchronously in the
/// frontend listener, so a remote caller never blocks on TUI startup. The
/// session's `pragma-watch` sidecar is the server's to start — see
/// `pragma_server::watchers`.
///
/// The tab is announced as `tabOpenedBackground` (not `tabOpened`) so the UI
/// refreshes without selecting it. Selecting would mount a terminal and spawn
/// an empty shell that races the background agent `ptySpawn`, leaving a plain
/// terminal with no agent command or prompt prefill.
fn agent_session_launch(
    app: &AppHandle,
    payload: serde_json::Value,
) -> AppResult<serde_json::Value> {
    let args: AgentSessionLaunchArgs = parse(payload)?;
    // Resolve or create the target worktree.
    let worktree = match (args.worktree_id, args.new_worktree) {
        (Some(id), None) => app.state::<Db>().worktree(&id)?,
        (None, Some(spec)) => {
            let worktree = worktrees::create_worktree(
                app.state::<Db>(),
                app.state::<Hosts>(),
                app.state::<GitLocks>(),
                app.state::<crate::workspace_mirror::WorkspacePublisher>(),
                args.project_id.clone(),
                spec.parent_worktree_id,
                spec.branch,
                spec.title,
            )?;
            emit_worktree_changed(
                app,
                "worktreeCreated",
                args.project_id.clone(),
                Some(worktree.id.clone()),
            );
            worktree
        }
        (Some(_), Some(_)) => {
            return Err(AppError::InvalidInput(
                "agentSessionLaunch: provide either worktreeId or newWorktree, not both"
                    .to_string(),
            ));
        }
        (None, None) => {
            return Err(AppError::InvalidInput(
                "agentSessionLaunch: worktreeId or newWorktree is required".to_string(),
            ));
        }
    };
    // Create a terminal tab in the resolved worktree.
    let tab = app.state::<Db>().create_tab(
        &worktree.project_id,
        &worktree.id,
        TabKind::Terminal,
        None,
        None,
        None,
        None,
        None,
        None,
    )?;
    // Tag the tab as agent-owned on the daemon before any workspace publish so
    // mobile/desktop list overlays see the agent icon immediately (SQLite does
    // not store agent metadata).
    let agent_title = agent_display_title(&args.agent_id);
    mark_launched_tab_agent(app, &tab, &args.agent_id, &agent_title);
    emit_tabs_changed(app, "tabOpenedBackground", &tab);
    app.state::<crate::workspace_mirror::WorkspacePublisher>()
        .trigger();
    let result = AgentSessionLaunchResult {
        worktree_id: worktree.id.clone(),
        tab_id: tab.id.clone(),
    };
    // Trigger the frontend launch sequence + a workspace mirror publish.
    let _ = app.emit(
        "pragma:agent-session-launch",
        serde_json::json!({
            "projectId": worktree.project_id,
            "worktreeId": worktree.id,
            "worktreePath": worktree.path,
            "tabId": tab.id,
            "agentId": args.agent_id,
            "modelId": args.model_id,
            "reasoningId": args.reasoning_id,
            "modelCmd": args.model_cmd,
            "prompt": args.prompt,
        }),
    );
    json(result)
}

/// Seeds a temporary display title from a catalog agent id (`plugin.agent` →
/// last segment). The frontend replaces it with the agent's real name once the
/// plugin catalog resolves.
fn agent_display_title(agent_id: &str) -> String {
    agent_id
        .rsplit('.')
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or(agent_id)
        .to_string()
}

/// Best-effort daemon `setAgent` so remote clients see an agent tab before the
/// frontend listener finishes. Failures are non-fatal: the FE still marks the
/// tab when it resolves the plugin agent.
fn mark_launched_tab_agent(app: &AppHandle, tab: &Tab, agent_id: &str, title: &str) {
    let db = app.state::<Db>();
    let hosts = app.state::<Hosts>();
    let Ok(pty) = hosts.for_project(&db, &tab.project_id) else {
        return;
    };
    let Ok(payload) = serde_json::to_value(TabsRequest::SetAgent {
        tab: Box::new(tab.clone()),
        agent_id: agent_id.to_string(),
        title: title.to_string(),
    }) else {
        return;
    };
    let _ = pty.rpc(ProtocolRpcMethod::Tabs, payload);
}

/// Brokered CLI agent starts are unsupported now that agents are plugin-defined
/// JavaScript. The frontend owns plugin arg builders/model providers and starts
/// agents through `agent-launch.ts`.
#[tauri::command]
pub fn start_agent(
    _app: AppHandle,
    _db: tauri::State<'_, Db>,
    _pty: tauri::State<'_, PtyClient>,
    _worktree_id: String,
    agent: String,
    _model: Option<String>,
    _prompt: Option<String>,
) -> AppResult<AgentStartResult> {
    Err(AppError::InvalidInput(format!(
        "agent start for '{agent}' must be launched from the Pragma UI; agents are now plugin-defined JavaScript"
    )))
}

/// Runs a command in a worktree without creating a tab.
#[tauri::command(async)]
pub fn exec_in_worktree(
    db: tauri::State<'_, Db>,
    hosts: tauri::State<'_, Hosts>,
    worktree_id: String,
    command: Vec<String>,
) -> AppResult<ExecResult> {
    let worktree = db.worktree(&worktree_id)?;
    let project = db.project(&worktree.project_id)?;
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    let command = shell_join(&command);
    let result = scripts::run_headless_command(&pty, &project, &worktree, &command)?;
    Ok(ExecResult {
        command: result.command,
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
    })
}

fn tab_kind(kind: &str) -> AppResult<TabKind> {
    match kind {
        "terminal" => Ok(TabKind::Terminal),
        "browser" => Ok(TabKind::Browser),
        "editor" => Ok(TabKind::Editor),
        "diff" => Ok(TabKind::Diff),
        "log" => Ok(TabKind::Log),
        "pr-review" => Ok(TabKind::PrReview),
        other => Err(AppError::InvalidInput(format!("unknown tab kind: {other}"))),
    }
}

fn diff_side(side: &str) -> AppResult<DiffSide> {
    match side {
        "committed" => Ok(DiffSide::Committed),
        "staged" => Ok(DiffSide::Staged),
        "unstaged" => Ok(DiffSide::Unstaged),
        "worktree" => Ok(DiffSide::Worktree),
        other => Err(AppError::InvalidInput(format!(
            "unknown diff side: {other}"
        ))),
    }
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-._/:".contains(c))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Joins an argv vector into a single shell command line, quoting each
/// argument so a `sh -c` re-parse reconstructs the original argument
/// boundaries instead of splitting on embedded spaces or shell metacharacters.
fn shell_join(argv: &[String]) -> String {
    argv.iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::{
        agent_display_title, scratchpad_document, scratchpad_slug, shell_join, BrowserHistory,
        ScratchpadMetadata,
    };

    #[test]
    fn scratchpad_document_adds_managed_frontmatter_without_losing_existing_fields() {
        let metadata = ScratchpadMetadata {
            version: 1,
            id: "scratch-1",
            title: "Architecture / Notes",
            agent_tab_id: "tab-1",
            agent_id: "opencode",
            created_at: 1,
        };
        let document = scratchpad_document("---\ncustom: kept\n---\n# Body\n", &metadata)
            .expect("scratchpad document");
        assert!(document.starts_with("---\npragmaScratchpad: {"));
        assert!(document.contains("\ncustom: kept\n---\n# Body\n"));
        assert_eq!(scratchpad_slug(metadata.title), "architecture-notes");
    }

    #[test]
    fn shell_join_preserves_argv_boundaries_through_a_shell_reparse() {
        let argv = vec![
            "git".to_string(),
            "log".to_string(),
            "--format=%s %ad".to_string(),
        ];
        let joined = shell_join(&argv);

        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("printf '%s\\n' {joined}"))
            .output()
            .expect("sh should run");
        let lines: Vec<&str> = std::str::from_utf8(&output.stdout)
            .expect("utf8 output")
            .lines()
            .collect();

        assert_eq!(lines, vec!["git", "log", "--format=%s %ad"]);
    }

    #[test]
    fn shell_join_single_plain_argument_is_unquoted() {
        assert_eq!(shell_join(&["status".to_string()]), "status");
    }

    #[test]
    fn agent_display_title_uses_the_catalog_id_tail() {
        assert_eq!(agent_display_title("pragma.claude-code"), "claude-code");
        assert_eq!(agent_display_title("opencode"), "opencode");
    }

    #[test]
    fn browser_history_tracks_offscreen_navigation_back_and_forward() {
        let history = BrowserHistory::default();

        history
            .record_offscreen_navigate("tab-1", Some("https://old.test/"), "https://new.test/")
            .expect("history should record");

        assert_eq!(
            history
                .back("tab-1", Some("https://new.test/"))
                .expect("back should resolve")
                .as_deref(),
            Some("https://old.test/"),
        );
        assert_eq!(
            history
                .forward("tab-1", Some("https://old.test/"))
                .expect("forward should resolve")
                .as_deref(),
            Some("https://new.test/"),
        );
    }

    #[test]
    fn browser_history_ignores_stale_current_url() {
        let history = BrowserHistory::default();

        history
            .record_offscreen_navigate("tab-1", Some("https://old.test/"), "https://new.test/")
            .expect("history should record");

        assert!(history
            .back("tab-1", Some("https://other.test/"))
            .expect("back should not fail")
            .is_none());
    }
}
