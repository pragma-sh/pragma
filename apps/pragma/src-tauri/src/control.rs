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

use pragma_constants::{ControlMethod, DiffSide, Tab, TabKind, Worktree, CONSTANTS};
use pragma_protocol::{
    read_json_frame, write_json_frame, ControlEnvelope, ControlResult, RequestFrame, RequestKind,
    ServerFrame,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::git::GitLocks;
use crate::hosts::Hosts;
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
pub fn start(app: AppHandle, pty: PtyClient) {
    thread::spawn(move || loop {
        if let Err(error) = register_once(&app, &pty) {
            log::warn!("control bridge disconnected: {error}");
            thread::sleep(Duration::from_millis(CONTROL_RECONNECT_MS));
        }
    });
}

fn register_once(app: &AppHandle, pty: &PtyClient) -> AppResult<()> {
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
    loop {
        match read_json_frame::<ServerFrame>(&mut stream)? {
            ServerFrame::Control(envelope) => {
                let result = dispatch(app, envelope.clone());
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
            | ServerFrame::Response(_)
            | ServerFrame::Rpc(_)
            | ServerFrame::Event(_)
            | ServerFrame::ControlResult(_) => {}
        }
    }
}

fn dispatch(app: &AppHandle, envelope: ControlEnvelope) -> ControlResult {
    match dispatch_inner(app, envelope.method, envelope.payload) {
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
) -> AppResult<serde_json::Value> {
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
    }
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
    let worktree = worktrees::rename_worktree(args.worktree_id, args.title, app.state::<Db>())?;
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
    let worktree = worktrees::hide_worktree(args.worktree_id, args.hidden, app.state::<Db>())?;
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
        args.worktree_id,
        args.delete_branch,
        args.force,
        app.state::<Db>(),
        app.state::<Hosts>(),
        app.state::<GitLocks>(),
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
    )?;
    if matches!(kind, TabKind::Terminal) {
        let pty = app.state::<PtyClient>();
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
    json(tab)
}

fn tab_close(app: &AppHandle, payload: serde_json::Value) -> AppResult<serde_json::Value> {
    let args: TabIdPayload = parse(payload)?;
    let tab = resolve_tab(app, &args.tab_id)?;
    app.state::<Db>().delete_tab(&tab.id)?;
    emit_tabs_changed(app, "tabClosed", &tab);
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
    )?;
    if matches!(kind, TabKind::Terminal) {
        let pty = app.state::<PtyClient>();
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

/// Consolidated Tauri command for starting an agent from UI or CLI.
#[tauri::command]
pub fn start_agent(
    app: AppHandle,
    db: tauri::State<'_, Db>,
    pty: tauri::State<'_, PtyClient>,
    worktree_id: String,
    agent: String,
    model: Option<String>,
    prompt: Option<String>,
) -> AppResult<AgentStartResult> {
    let agents = crate::agents::list_agents(app)?;
    let config = agents
        .into_iter()
        .find(|candidate| candidate.id == agent)
        .ok_or_else(|| AppError::InvalidInput(format!("unknown agent: {agent}")))?;
    let worktree = db.worktree(&worktree_id)?;
    let tab = db.create_tab(
        &worktree.project_id,
        &worktree.id,
        TabKind::Terminal,
        Some(config.name.clone()),
        None,
        None,
        None,
        None,
    )?;
    pty.spawn_detached(
        tab.id.clone(),
        worktree.id.clone(),
        worktree.path.clone(),
        DEFAULT_COLS,
        DEFAULT_ROWS,
    )?;
    let mut command = config.start.join(" ");
    if let Some(model) = model {
        command.push_str(" --model ");
        command.push_str(&shell_quote(&model));
    }
    // Mirror the frontend's fixed startup delay (see agent-launch.ts) so the
    // shell has time to become ready before we write to it. There is no
    // readiness signal from the PTY, so both sides use the same shared,
    // best-effort delay.
    thread::sleep(Duration::from_millis(CONSTANTS.agents.start_delay_ms));
    let _ = pty.write(tab.id.clone(), format!("{command}\r"));
    if let Some(prompt) = prompt {
        let _ = pty.write(tab.id.clone(), format!("{prompt}\r"));
    }
    Ok(AgentStartResult { tab_id: tab.id })
}

/// Runs a command in a worktree without creating a tab.
#[tauri::command]
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
    use super::{shell_join, BrowserHistory};

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
