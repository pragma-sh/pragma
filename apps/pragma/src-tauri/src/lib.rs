// Tauri command extraction requires owned IPC arguments and `State<T>` values.
#![allow(clippy::needless_pass_by_value)]

mod agent_cli;
mod agent_events;
mod agent_notifications;
mod ai;
mod automations;
mod browser;
mod config_file;
mod control;
mod db;
#[allow(clippy::all, clippy::pedantic, dead_code)]
mod dev_bridge;
mod editors;
mod error;
mod fs;
mod git;
mod github;
mod hosts;
mod icons;
mod kanban;
mod keybindings;
mod plugins;
mod ports;
pub(crate) use pragma_core::process_env;
mod projects;
mod pty;
mod scripts;
mod ssh_host;
mod window_chrome;
mod workspace_mirror;
mod worktrees;

use pragma_client::router::RouterDb;
use pragma_constants::{
    AgentDecision, AppInfo, DiffSide, KeybindingsConfig, ProjectIcon, ProtocolRpcMethod, Tab,
    TabKind, CONSTANTS,
};
use pragma_core::tabs::{TabAgentMetadata, TabsRequest};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::db::{Db, SplitLayout};
use crate::error::{AppError, AppResult};
use crate::git::GitLocks;
use crate::hosts::{Hosts, LOCAL_HOST};
use crate::pty::PtyClient;

/// Menu item id for "Restart Server" in the Troubleshooting submenu.
const MENU_RESTART_DAEMON: &str = "troubleshooting.restart-daemon";
/// Menu item id for "Open Server Logs" in the Troubleshooting submenu.
const MENU_OPEN_DAEMON_LOGS: &str = "troubleshooting.open-daemon-logs";
/// Menu item id for creating a terminal tab from the native menu.
const MENU_NEW_TERMINAL_TAB: &str = "tabs.new-terminal";
/// Menu item id for closing the active tab from the native menu.
const MENU_CLOSE_ACTIVE_TAB: &str = "tabs.close-active";
/// Menu item id for opening the project command palette from the native menu.
const MENU_OPEN_COMMAND_PALETTE: &str = "workspace.open-command-palette";
/// Menu item id for opening the palette directly in command mode.
const MENU_OPEN_COMMAND_MODE: &str = "workspace.open-command-mode";
/// Menu item id for opening the full-frame Settings view.
const MENU_OPEN_SETTINGS: &str = "settings.open";
/// Tauri event the menu emits to the frontend; payload is one of the menu ids
/// above. The workspace shell handles it so tab lifecycle and feedback stay
/// consistent with their UI controls.
const MENU_EVENT: &str = "pragma:menu";

/// Tauri event emitted for each incoming `pragma://` deep link; payload is the
/// raw URL string. The frontend parses it (`lib/deep-link.ts`) and opens the
/// new-session flow. Deep links that arrive at launch (cold start) instead land in
/// [`PendingDeepLink`] for the frontend to drain once on mount.
const DEEP_LINK_EVENT: &str = "pragma:deep-link";

/// Holds a `pragma://` URL captured during launch, before the frontend has
/// attached its [`DEEP_LINK_EVENT`] listener. The frontend drains it exactly
/// once via [`take_pending_deep_link`]; runtime deep links skip this and are
/// emitted live.
#[derive(Default)]
struct PendingDeepLink(std::sync::Mutex<Option<String>>);

/// Returns and clears any deep link captured at launch. Called by the frontend
/// on mount so a cold-start `pragma://` URL — delivered before the live event
/// listener existed — is not lost.
#[tauri::command]
fn take_pending_deep_link(pending: tauri::State<'_, PendingDeepLink>) -> Option<String> {
    pending.0.lock().ok().and_then(|mut guard| guard.take())
}

/// Label of the app's main window (Tauri's default when none is set in config).
const MAIN_WINDOW_LABEL: &str = "main";

/// Raises and focuses the main window so a deep link surfaces the app.
///
/// Crucial on macOS: a fullscreen window lives on its own Space, and only the app
/// activating itself (`set_focus` → `makeKeyAndOrderFront:` + `NSApp activate`)
/// makes the OS switch to it. Without this, a `pragma://` link is handled
/// invisibly on the Space the user is currently looking at.
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        if let Err(error) = window.set_focus() {
            log::warn!("failed to focus main window for deep link: {error}");
        }
    }
}

/// Wires `pragma://` deep-link delivery: registers the scheme at runtime (needed
/// for Linux/dev where no installed bundle owns it), stashes any launch URL into
/// [`PendingDeepLink`], and forwards every runtime URL to the frontend via
/// [`DEEP_LINK_EVENT`].
fn install_deep_links(app: &tauri::App) {
    app.manage(PendingDeepLink::default());
    // On Linux the scheme is owned by a generated `.desktop` file; register it at
    // runtime so it works without a packaged install (and during development).
    #[cfg(target_os = "linux")]
    if let Err(error) = app.deep_link().register_all() {
        log::warn!("failed to register deep-link schemes: {error}");
    }
    // Capture a URL the app was launched with — the frontend drains it on mount.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        if let Some(url) = urls.into_iter().next() {
            if let Some(pending) = app.try_state::<PendingDeepLink>() {
                if let Ok(mut guard) = pending.0.lock() {
                    *guard = Some(url.to_string());
                }
            }
            // A cold-start link can land while another app holds a fullscreen
            // Space; surface our window so the new session is actually seen.
            focus_main_window(app.handle());
        }
    }
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        // Bring the app forward first — a fullscreen Pragma on its own macOS
        // Space won't switch into view unless the app activates itself.
        focus_main_window(&handle);
        for url in event.urls() {
            let _ = handle.emit(DEEP_LINK_EVENT, url.to_string());
        }
    });
}

/// Installs the application menu plus Pragma tab and troubleshooting actions.
/// Native accelerators must be menu items: macOS consumes Cmd+W before `WebView`
/// listeners see it, and `WebKit` may consume Cmd+T for a browser tab.
fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    install_workspace_menu(app, &menu)?;
    let restart_daemon = MenuItem::with_id(
        app,
        MENU_RESTART_DAEMON,
        "Restart Server",
        true,
        None::<&str>,
    )?;
    let open_logs = MenuItem::with_id(
        app,
        MENU_OPEN_DAEMON_LOGS,
        "Open Server Logs",
        true,
        None::<&str>,
    )?;
    let troubleshooting =
        Submenu::with_items(app, "Troubleshooting", true, &[&restart_daemon, &open_logs])?;
    menu.append(&troubleshooting)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let action = event.id().as_ref();
        if matches!(
            action,
            MENU_RESTART_DAEMON
                | MENU_OPEN_DAEMON_LOGS
                | MENU_NEW_TERMINAL_TAB
                | MENU_CLOSE_ACTIVE_TAB
                | MENU_OPEN_COMMAND_PALETTE
                | MENU_OPEN_COMMAND_MODE
                | MENU_OPEN_SETTINGS
        ) {
            let _ = app.emit(MENU_EVENT, action);
        }
    });
    Ok(())
}

/// Installs native workspace actions, including accelerators `WebKit` may consume.
fn install_workspace_menu(app: &tauri::AppHandle, menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
    let open_settings = MenuItem::with_id(
        app,
        MENU_OPEN_SETTINGS,
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let new_terminal_tab = MenuItem::with_id(
        app,
        MENU_NEW_TERMINAL_TAB,
        "New Terminal Tab",
        true,
        Some("CmdOrCtrl+T"),
    )?;
    let close_active_tab = MenuItem::with_id(
        app,
        MENU_CLOSE_ACTIVE_TAB,
        "Close Tab",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    let open_command_palette = MenuItem::with_id(
        app,
        MENU_OPEN_COMMAND_PALETTE,
        "Open Command Palette",
        true,
        Some("CmdOrCtrl+P"),
    )?;
    let open_command_mode = MenuItem::with_id(
        app,
        MENU_OPEN_COMMAND_MODE,
        "Open Command Mode",
        true,
        Some("CmdOrCtrl+Shift+P"),
    )?;

    #[cfg(target_os = "macos")]
    install_macos_workspace_menu(
        app,
        menu,
        &open_settings,
        &new_terminal_tab,
        &close_active_tab,
        &open_command_palette,
        &open_command_mode,
    )?;
    #[cfg(target_os = "linux")]
    install_linux_workspace_menu(
        menu,
        &open_settings,
        &new_terminal_tab,
        &close_active_tab,
        &open_command_palette,
        &open_command_mode,
    )?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_macos_workspace_menu(
    app: &tauri::AppHandle,
    menu: &Menu<tauri::Wry>,
    open_settings: &MenuItem<tauri::Wry>,
    new_terminal_tab: &MenuItem<tauri::Wry>,
    close_active_tab: &MenuItem<tauri::Wry>,
    open_command_palette: &MenuItem<tauri::Wry>,
    open_command_mode: &MenuItem<tauri::Wry>,
) -> tauri::Result<()> {
    // Tauri's default app submenu has a generated id, so resolve its stable
    // first position rather than looking up an id that does not exist.
    if let Some(app_menu) = menu
        .items()?
        .into_iter()
        .next()
        .and_then(|item| item.as_submenu().cloned())
    {
        app_menu.insert(open_settings, 2)?;
    }
    // Replace File entirely: its default Close Window item keeps Cmd+W even when
    // removed in place on macOS.
    let file_menu = Submenu::with_id_and_items(
        app,
        "file",
        "File",
        true,
        &[
            new_terminal_tab,
            close_active_tab,
            open_command_palette,
            open_command_mode,
        ],
    )?;
    menu.remove_at(1)?;
    menu.insert(&file_menu, 1)?;
    if let Some(window_menu) = menu
        .get("window")
        .and_then(|item| item.as_submenu().cloned())
    {
        // The default macOS Window menu also owns Cmd+W for closing the window.
        window_menu.remove_at(3)?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn install_linux_workspace_menu(
    menu: &Menu<tauri::Wry>,
    open_settings: &MenuItem<tauri::Wry>,
    new_terminal_tab: &MenuItem<tauri::Wry>,
    close_active_tab: &MenuItem<tauri::Wry>,
    open_command_palette: &MenuItem<tauri::Wry>,
    open_command_mode: &MenuItem<tauri::Wry>,
) -> tauri::Result<()> {
    if let Some(window_menu) = menu
        .get("window")
        .and_then(|item| item.as_submenu().cloned())
    {
        // Linux has no default File menu, so surface Pragma tab actions here.
        window_menu.append(open_settings)?;
        window_menu.append(new_terminal_tab)?;
        window_menu.append(close_active_tab)?;
        window_menu.append(open_command_palette)?;
        window_menu.append(open_command_mode)?;
    }
    Ok(())
}

/// Returns the shared application info (name, identifier, version).
#[tauri::command]
fn app_info() -> AppInfo {
    CONSTANTS.app.clone()
}

/// Returns the runtime platform name used to select keybinding chords.
///
/// Pragma targets macOS and Linux only; this collapses to "mac" or "linux".
#[tauri::command]
fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    }
}

/// Loads the user keybindings config, writing the default file if it is missing.
#[tauri::command]
fn load_keybindings(app_handle: tauri::AppHandle) -> AppResult<KeybindingsConfig> {
    keybindings::load_or_ensure(app_handle.path().home_dir()?)
}

/// Saves a keybindings config back to `~/.pragma/keybindings.json`.
#[tauri::command]
fn save_keybindings(app_handle: tauri::AppHandle, config: KeybindingsConfig) -> AppResult<()> {
    keybindings::save(app_handle.path().home_dir()?, &config)
}

/// Reads plugin entries from `~/.pragma/config.json` plus the active project's
/// `.pragma/config.json`, resolving each to a manifest or a per-entry error.
#[tauri::command(async)]
fn read_plugin_manifests(
    app_handle: tauri::AppHandle,
    project_path: Option<String>,
) -> AppResult<Vec<plugins::PluginEntryResult>> {
    let home = app_handle.path().home_dir()?;
    let resource_dir = app_handle.path().resource_dir().ok();
    let results = plugins::read_manifests(
        home,
        project_path.as_deref().map(std::path::Path::new),
        resource_dir.as_deref(),
    );
    // Plugin icons load through the asset protocol (`convertFileSrc`), which
    // only serves paths explicitly allowed in its scope. Plugin dirs are
    // arbitrary (bundled, global, or project-declared), so grant each one
    // here rather than trying to enumerate them statically in tauri.conf.json.
    let scope = app_handle.asset_protocol_scope();
    for result in &results {
        if let Some(manifest) = &result.manifest {
            let _ = scope.allow_directory(&manifest.dir, true);
        }
    }
    Ok(results)
}

/// Reads the JavaScript source of a resolved plugin bundle file.
#[tauri::command(async)]
fn read_plugin_bundle(main_path: String) -> AppResult<String> {
    plugins::read_bundle(std::path::Path::new(&main_path))
}

/// Starts a host-side watcher sidecar for a plugin-owned agent session.
#[tauri::command(async)]
fn start_plugin_watcher(request: plugins::StartWatcherRequest) -> AppResult<()> {
    plugins::start_watcher(request)
}

/// Ensures the local HTTP gateway is running and returns its base URL + token.
#[tauri::command]
async fn gateway_connection_info(
    pty: tauri::State<'_, PtyClient>,
) -> AppResult<pty::GatewayConnectionInfo> {
    pty.gateway_connection_info()
}

/// Regenerates the gateway bearer token (kills, deletes the token file, and
/// respawns the gateway) and returns the fresh connection info. Paired devices
/// disconnect until they re-pair with the new token.
#[tauri::command]
async fn regenerate_gateway_token(
    pty: tauri::State<'_, PtyClient>,
) -> AppResult<pty::GatewayConnectionInfo> {
    pty.regenerate_gateway_token()
}

/// Lists mobile installations that have authenticated with the local gateway.
#[tauri::command]
async fn gateway_devices(pty: tauri::State<'_, PtyClient>) -> AppResult<Vec<pty::GatewayDevice>> {
    pty.gateway_devices()
}

/// Starts the remote-access tunnel exposing the local gateway, returning the
/// current tunnel status. Poll `tunnel_status` until it becomes `active`.
#[tauri::command]
async fn tunnel_start(pty: tauri::State<'_, PtyClient>) -> AppResult<serde_json::Value> {
    pty.gateway_connection_info()?;
    pty.rpc(
        pragma_constants::ProtocolRpcMethod::Tunnel,
        serde_json::json!({ "action": "start" }),
    )
}

/// Stops the remote-access tunnel (kills the child); paired devices disconnect.
#[tauri::command]
async fn tunnel_stop(pty: tauri::State<'_, PtyClient>) -> AppResult<()> {
    pty.rpc(
        pragma_constants::ProtocolRpcMethod::Tunnel,
        serde_json::json!({ "action": "stop" }),
    )?;
    Ok(())
}

/// Returns the current remote-access tunnel status.
#[tauri::command]
async fn tunnel_status(pty: tauri::State<'_, PtyClient>) -> AppResult<serde_json::Value> {
    pty.rpc(
        pragma_constants::ProtocolRpcMethod::Tunnel,
        serde_json::json!({ "action": "status" }),
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // PTY spawn carries session + geometry + channel.
async fn pty_spawn(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    hosts: tauri::State<'_, Hosts>,
    session_id: String,
    worktree_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: Channel<InvokeResponseBody>,
) -> AppResult<()> {
    // Resolve which host owns this worktree's project and pin the session to it,
    // so later session-keyed ops (write/resize/kill) reach the same server.
    let host_id = hosts.host_id_for_worktree(&db, &worktree_id)?;
    let is_local_host = host_id == LOCAL_HOST;
    let client = ssh_host::client_for_host(app, &hosts, &host_id).await?;
    hosts.bind_session(session_id.clone(), host_id)?;
    run_pty_task(move || {
        if is_local_host {
            if let Err(error) = client.ensure_gateway() {
                log::warn!("failed to ensure pragma-gateway before PTY spawn: {error}");
            }
        }
        client.spawn(session_id, worktree_id, cwd, cols, rows, on_event)
    })
    .await
}

#[tauri::command]
async fn pty_attach(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    hosts: tauri::State<'_, Hosts>,
    session_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<InvokeResponseBody>,
) -> AppResult<()> {
    // Resolve (and re-bind) the session's host the same way `pty_spawn` does,
    // rather than `hosts.for_session`'s bare in-memory lookup: that binding is
    // lost on every app restart and silently defaults to `local`, which sends
    // a reconnecting remote session's attach at the wrong daemon. That attach
    // then fails, the frontend falls back to `pty_spawn`, and `pty_spawn`
    // (which does resolve the real remote host) collides with the session
    // still alive there — surfacing as "session already exists".
    let client = ssh_host::client_for_session(app, &db, &hosts, &session_id).await?;
    run_pty_task(move || client.attach(session_id, cols, rows, on_event)).await
}

#[tauri::command]
async fn pty_write(
    hosts: tauri::State<'_, Hosts>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    // Keystroke input is the latency-critical path. `write` only enqueues onto
    // the dedicated writer thread (no socket I/O, no daemon round-trip), so there
    // is nothing to offload — running it inline keeps every keystroke off the
    // blocking-pool scheduler entirely.
    hosts.for_session(&session_id)?.write(session_id, data)
}

#[tauri::command]
async fn pty_resize(
    hosts: tauri::State<'_, Hosts>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    let client = hosts.for_session(&session_id)?;
    run_pty_task(move || client.resize(session_id, cols, rows)).await
}

#[tauri::command]
async fn pty_kill(hosts: tauri::State<'_, Hosts>, session_id: String) -> AppResult<()> {
    let client = hosts.for_session(&session_id)?;
    let sid = session_id.clone();
    run_pty_task(move || client.kill(sid)).await?;
    hosts.unbind_session(&session_id)
}

/// Asks every connected host to terminate every shell whose initial cwd is
/// `path`. Used as a safety net when a worktree is deleted from disk so the
/// user's running processes don't keep an open handle to a now-removed
/// directory. Broadcast because the deletion isn't tied to one resolved host.
#[tauri::command]
async fn pty_kill_for_path(hosts: tauri::State<'_, Hosts>, path: String) -> AppResult<()> {
    let clients = hosts.all_clients()?;
    run_pty_task(move || {
        for client in clients {
            let _ = client.kill_for_cwd(path.clone());
        }
        Ok(())
    })
    .await
}

/// Marks a tab's resolved (`done`) agent indicators as seen once the user views
/// the tab, so the daemon drops them and a later subscriber reconnect doesn't
/// replay (and re-notify) a completion the user already looked at. Broadcast to
/// every host since the tab's agent could be tracked by any of them.
#[tauri::command]
async fn mark_agents_seen(hosts: tauri::State<'_, Hosts>, tab_id: String) -> AppResult<()> {
    let clients = hosts.all_clients()?;
    run_pty_task(move || {
        for client in clients {
            let _ = client.mark_agents_seen(tab_id.clone());
        }
        Ok(())
    })
    .await
}

/// Publishes a command-approval verdict from the approval toast. The server
/// fans it out to agent subscribers so the waiting harness hook (Claude Code) or
/// plugin watcher (cursor/opencode) runs or rejects the command. Broadcast to
/// every host since the tab's agent could be tracked by any of them; only the
/// reporter waiting on this `request_id` acts.
#[tauri::command]
async fn resolve_agent_approval(
    hosts: tauri::State<'_, Hosts>,
    agent: String,
    worktree_id: String,
    tab_id: String,
    request_id: String,
    approved: bool,
) -> AppResult<()> {
    let clients = hosts.all_clients()?;
    let decision = AgentDecision {
        agent,
        worktree_id,
        tab_id,
        request_id,
        approved,
    };
    run_pty_task(move || {
        for client in &clients {
            let _ = client.report_agent_decision(&decision);
        }
        Ok(())
    })
    .await
}

/// Returns, for each given worktree id, whether it belongs to an SSH-routed
/// remote project. Batched so the frontend can resolve many worktrees in one
/// IPC round trip instead of fanning out a call per worktree. A worktree id
/// that fails to resolve (e.g. already deleted) is reported as not remote.
#[tauri::command]
fn worktrees_are_remote(
    db: tauri::State<'_, Db>,
    hosts: tauri::State<'_, Hosts>,
    worktree_ids: Vec<String>,
) -> std::collections::HashMap<String, bool> {
    worktree_ids
        .into_iter()
        .map(|worktree_id| {
            let is_remote = hosts
                .host_id_for_worktree(&db, &worktree_id)
                .is_ok_and(|host_id| host_id != LOCAL_HOST);
            (worktree_id, is_remote)
        })
        .collect()
}

/// Opens a live filesystem-change subscription for a worktree, streaming each
/// change to the webview over `on_event`. The worktree's trusted absolute root
/// is resolved from the DB here — no absolute path crosses IPC — and the watch
/// runs on the worktree's host.
#[tauri::command]
async fn watch_worktree_files(
    app: tauri::AppHandle,
    db: tauri::State<'_, Db>,
    hosts: tauri::State<'_, Hosts>,
    worktree_id: String,
    on_event: Channel<InvokeResponseBody>,
) -> AppResult<()> {
    let root = db.worktree(&worktree_id)?.path;
    let client = ssh_host::client_for_worktree(app, &db, &hosts, &worktree_id).await?;
    run_pty_task(move || client.watch_files(worktree_id, root, on_event)).await
}

async fn run_pty_task(task: impl FnOnce() -> AppResult<()> + Send + 'static) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| AppError::Daemon(format!("pty task failed: {error}")))?
}

/// Restarts the persistent PTY server (Troubleshooting menu). Kills the running
/// server and spawns a fresh build, terminating every running shell session.
#[tauri::command]
async fn restart_daemon(pty: tauri::State<'_, PtyClient>) -> AppResult<()> {
    let client = pty.inner().clone();
    run_pty_task(move || {
        client.restart()?;
        client.ensure_gateway()
    })
    .await
}

/// Returns the current contents of the server log file (empty if not yet
/// created). Backs the Troubleshooting menu's "Open Server Logs" tab.
#[tauri::command(async)]
fn read_daemon_log(pty: tauri::State<'_, PtyClient>) -> AppResult<String> {
    pty.read_log()
}

#[tauri::command]
fn project_icon(db: tauri::State<'_, Db>, project_id: String) -> AppResult<Option<ProjectIcon>> {
    icons::project_icon(&db, project_id)
}

#[tauri::command(async)]
fn list_tabs(
    db: tauri::State<'_, Db>,
    hosts: tauri::State<'_, Hosts>,
    project_id: String,
) -> AppResult<Vec<Tab>> {
    let mut tabs = db.list_tabs(&project_id)?;
    let tab_ids = tabs.iter().map(|tab| tab.id.clone()).collect();
    let Ok(pty) = hosts.for_project(&db, &project_id) else {
        return Ok(tabs);
    };
    let request = TabsRequest::ListAgents { tab_ids };
    let Ok(value) = pty.rpc(ProtocolRpcMethod::Tabs, serde_json::to_value(request)?) else {
        return Ok(tabs);
    };
    let metadata: Vec<TabAgentMetadata> = serde_json::from_value(value)?;
    for tab in &mut tabs {
        let Some(agent) = metadata.iter().find(|agent| agent.tab_id == tab.id) else {
            continue;
        };
        tab.agent_id = Some(agent.agent_id.clone());
        if !tab.user_renamed {
            tab.title.clone_from(&agent.title);
        }
    }
    Ok(tabs)
}

// A tab carries enough locating data (kind/title/url/file/diff side) that the
// create command naturally takes more than clippy's default arg ceiling.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn create_tab(
    db: tauri::State<'_, Db>,
    publisher: tauri::State<'_, workspace_mirror::WorkspacePublisher>,
    project_id: String,
    worktree_id: String,
    kind: TabKind,
    title: Option<String>,
    url: Option<String>,
    file_path: Option<String>,
    diff_side: Option<DiffSide>,
    diff_commit: Option<String>,
    pr_number: Option<i64>,
) -> AppResult<Tab> {
    let tab = db.create_tab(
        &project_id,
        &worktree_id,
        kind,
        title,
        url,
        file_path,
        diff_side,
        diff_commit,
        pr_number,
    )?;
    publisher.trigger();
    Ok(tab)
}

// A plugin webview tab carries plugin locator fields plus an opaque payload string.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn create_plugin_webview_tab(
    db: tauri::State<'_, Db>,
    publisher: tauri::State<'_, workspace_mirror::WorkspacePublisher>,
    project_id: String,
    worktree_id: String,
    title: Option<String>,
    plugin_id: String,
    plugin_view_id: String,
    plugin_payload: Option<String>,
    plugin_dedupe_key: Option<String>,
) -> AppResult<Tab> {
    let tab = db.create_plugin_webview_tab(
        &project_id,
        &worktree_id,
        title,
        Some(plugin_id),
        Some(plugin_view_id),
        plugin_payload,
        plugin_dedupe_key,
    )?;
    publisher.trigger();
    Ok(tab)
}

#[tauri::command]
fn close_tab(
    db: tauri::State<'_, Db>,
    publisher: tauri::State<'_, workspace_mirror::WorkspacePublisher>,
    tab_id: String,
) -> AppResult<()> {
    db.delete_tab(&tab_id)?;
    publisher.trigger();
    Ok(())
}

#[tauri::command]
fn rename_tab(
    db: tauri::State<'_, Db>,
    publisher: tauri::State<'_, workspace_mirror::WorkspacePublisher>,
    tab_id: String,
    title: String,
) -> AppResult<Tab> {
    let tab = db.rename_tab(&tab_id, &title)?;
    publisher.trigger();
    Ok(tab)
}

/// Persists a shell-driven tab title (OSC 0/2) without touching the
/// `user_renamed` flag. The frontend reducer is responsible for refusing
/// to apply the update when the user has explicitly renamed the tab.
#[tauri::command(async)]
fn set_tab_title(
    db: tauri::State<'_, Db>,
    hosts: tauri::State<'_, Hosts>,
    publisher: tauri::State<'_, workspace_mirror::WorkspacePublisher>,
    tab_id: String,
    title: String,
) -> AppResult<Tab> {
    let tab = db.set_tab_title(&tab_id, &title)?;
    if let Ok(pty) = hosts.for_project(&db, &tab.project_id) {
        let _ = pty.rpc(
            ProtocolRpcMethod::Tabs,
            serde_json::to_value(TabsRequest::SetTitle { tab_id, title })?,
        );
    }
    publisher.trigger();
    Ok(tab)
}

/// Records which agent was launched into a terminal tab and seeds the tab's
/// title with the agent's display name (user renames win). The tab shows the
/// agent's icon and ignores shell OSC titles from then on.
#[tauri::command(async)]
fn set_tab_agent(
    db: tauri::State<'_, Db>,
    hosts: tauri::State<'_, Hosts>,
    tab_id: String,
    agent_id: String,
    title: String,
) -> AppResult<()> {
    let tab = db.tab(&tab_id)?;
    let pty = hosts.for_project(&db, &tab.project_id)?;
    pty.rpc(
        ProtocolRpcMethod::Tabs,
        serde_json::to_value(TabsRequest::SetAgent {
            tab: Box::new(tab),
            agent_id,
            title,
        })?,
    )?;
    Ok(())
}

/// Persists the current page URL for a browser tab (session restore).
#[tauri::command]
fn set_tab_url(
    db: tauri::State<'_, Db>,
    publisher: tauri::State<'_, workspace_mirror::WorkspacePublisher>,
    tab_id: String,
    url: String,
) -> AppResult<Tab> {
    let tab = db.set_tab_url(&tab_id, &url)?;
    publisher.trigger();
    Ok(tab)
}

/// Lists the persisted split-pane layouts for a project's worktrees.
#[tauri::command]
fn list_splits(db: tauri::State<'_, Db>, project_id: String) -> AppResult<Vec<SplitLayout>> {
    db.list_splits(&project_id)
}

/// Persists a worktree's split-pane layout (opaque, frontend-owned JSON).
#[tauri::command]
fn set_split_layout(
    db: tauri::State<'_, Db>,
    worktree_id: String,
    layout: String,
) -> AppResult<()> {
    db.set_split_layout(&worktree_id, &layout)
}

/// Clears a worktree's split-pane layout when it collapses back to a single pane.
#[tauri::command]
fn clear_split_layout(db: tauri::State<'_, Db>, worktree_id: String) -> AppResult<()> {
    db.clear_split_layout(&worktree_id)
}

/// Settings key holding the persisted active selection (last active project +
/// per-project last active worktree) as opaque, frontend-owned JSON. Rust never
/// parses the value — it stores and returns the string verbatim, mirroring the
/// split-layout persistence.
const ACTIVE_SELECTION_KEY: &str = "activeSelection";

/// Returns the persisted active selection as opaque, frontend-owned JSON, or
/// `None` on first launch. The frontend parses the shape; Rust is uninvolved.
#[tauri::command]
fn get_active_selection(db: tauri::State<'_, Db>) -> AppResult<Option<String>> {
    db.setting(ACTIVE_SELECTION_KEY)
}

/// Persists the active selection as opaque, frontend-owned JSON.
#[tauri::command]
fn set_active_selection(db: tauri::State<'_, Db>, value: String) -> AppResult<()> {
    db.set_setting(ACTIVE_SELECTION_KEY, &value)
}

/// Reads one plugin-owned storage value as opaque JSON, or `None` if unset.
#[tauri::command]
fn plugin_storage_get(
    db: tauri::State<'_, Db>,
    plugin_id: String,
    key: String,
) -> AppResult<Option<String>> {
    db.plugin_storage_get(&plugin_id, &key)
}

/// Writes one plugin-owned storage value as opaque JSON.
#[tauri::command]
fn plugin_storage_set(
    db: tauri::State<'_, Db>,
    plugin_id: String,
    key: String,
    value: String,
) -> AppResult<()> {
    db.plugin_storage_set(&plugin_id, &key, &value)
}

/// Wires the app's managed state, menu, and dev-only plugins during Tauri setup.
/// Extracted from `run` so the builder chain stays readable (and within the
/// per-function line budget).
fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        app.handle().plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )?;
    }
    let app_data_dir = app.path().app_data_dir()?;
    // Resolve this build's isolation channel once: production shares the stable
    // `pragma` channel; every dev build gets a `pragma-dev-<hash>` unique to the
    // worktree it was compiled in. The channel scopes BOTH the per-instance data
    // dir (`SQLite` DB + GitHub token) and the daemon, so a dev build can never read
    // or corrupt the production store — or another worktree's — and never attaches
    // to the wrong daemon.
    let channel = pty::instance_channel(app.config().product_name.as_deref());
    let data_dir = pty::instance_data_dir(&app_data_dir, &channel);
    std::fs::create_dir_all(&data_dir)?;
    if let Err(error) = agent_cli::ensure_installed(app.handle(), &data_dir, &channel) {
        log::warn!("failed to install pragma-cli: {error}");
    }
    let router = RouterDb::open(data_dir.join("router.db"))?;
    app.manage(Db::open(data_dir.join("pragma.db"))?);
    app.manage(github::TokenStore::new(&data_dir));
    let resource_dir = app.path().resource_dir().ok();
    let pty = PtyClient::new(app_data_dir, channel, resource_dir);
    // The local client stays managed for host-agnostic consumers (agent event
    // bridge, server restart/logs); `Hosts` owns the project → host routing and
    // the per-host clients, and is what the worktree/session commands resolve.
    app.manage(pty.clone());
    app.manage(Hosts::new(pty.clone(), router));
    app.manage(GitLocks::default());
    app.manage(ai::LoginRegistry::default());
    app.manage(control::BrowserHistory::default());
    // Mirror the workspace (projects/worktrees/tabs) to pragma-server so a paired
    // phone can render the session launcher without being the controller. Debounced
    // on a worker thread; never reads SQLite on the mac main thread.
    let workspace_publisher = workspace_mirror::WorkspacePublisher::start(app.handle().clone());
    // Seed the server's cached snapshot at launch so a phone pairing with a
    // freshly-started desktop sees its projects/worktrees/tabs immediately,
    // rather than an empty list until the first mutation triggers a publish.
    workspace_publisher.trigger();
    app.manage(workspace_publisher);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window_chrome::apply(&window);
    }
    install_menu(app.handle())?;
    install_deep_links(app);
    ensure_gateway_in_background(pty.clone());
    agent_events::start_for(app.handle().clone(), pty.clone());
    automations::start(app.handle().clone(), pty.clone());
    control::start(app.handle().clone(), pty);
    ssh_host::reconnect_remote_hosts(app.handle().clone());
    if let Err(error) = keybindings::load_or_ensure(app.path().home_dir()?) {
        log::warn!("failed to load keybindings config: {error}");
    }
    if cfg!(debug_assertions) {
        if let Err(error) = dev_bridge::start_bridge(app.handle()).map(|_| ()) {
            log::warn!("failed to start tauri-agent-tools dev bridge: {error}");
        }
    }
    Ok(())
}

fn ensure_gateway_in_background(pty: PtyClient) {
    std::thread::spawn(move || {
        if let Err(error) = pty.ensure_gateway() {
            log::warn!("failed to start pragma-gateway: {error}");
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::too_many_lines)] // The Tauri builder is one long registration chain.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_decorum::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(setup_app)
        .invoke_handler(tauri::generate_handler![
            app_info,
            platform_name,
            load_keybindings,
            save_keybindings,
            read_plugin_manifests,
            read_plugin_bundle,
            start_plugin_watcher,
            gateway_connection_info,
            regenerate_gateway_token,
            gateway_devices,
            config_file::read_config,
            config_file::write_config,
            tunnel_start,
            tunnel_stop,
            tunnel_status,
            pty_spawn,
            pty_attach,
            pty_write,
            pty_resize,
            pty_kill,
            pty_kill_for_path,
            watch_worktree_files,
            mark_agents_seen,
            resolve_agent_approval,
            worktrees_are_remote,
            take_pending_deep_link,
            restart_daemon,
            read_daemon_log,
            projects::list_projects,
            projects::add_project,
            projects::clone_project,
            projects::get_projects_directory,
            ssh_host::connect_remote_project,
            worktrees::list_worktrees,
            worktrees::touch_worktree_mru,
            worktrees::list_worktree_mru,
            worktrees::create_worktree,
            worktrees::worktree_status,
            worktrees::rename_worktree,
            worktrees::hide_worktree,
            worktrees::delete_worktree,
            scripts::load_project_scripts,
            editors::open_worktree,
            agent_notifications::show_agent_notification,
            control::start_agent,
            control::exec_in_worktree,
            project_icon,
            list_tabs,
            create_tab,
            create_plugin_webview_tab,
            close_tab,
            rename_tab,
            set_tab_title,
            set_tab_agent,
            set_tab_url,
            list_splits,
            set_split_layout,
            clear_split_layout,
            get_active_selection,
            set_active_selection,
            plugin_storage_get,
            plugin_storage_set,
            kanban::list_kanban_cards,
            kanban::create_kanban_card,
            kanban::update_kanban_card,
            kanban::move_kanban_card,
            kanban::delete_kanban_card,
            fs::list_dir_entries,
            fs::create_file,
            fs::create_folder,
            fs::path_exists,
            fs::read_file,
            fs::write_file,
            fs::rename_file,
            fs::delete_file,
            fs::palette_search,
            fs::cancel_palette_search,
            ports::list_open_ports,
            git::worktree_changes,
            git::worktree_commits,
            git::worktrees_merged_status,
            git::file_diff,
            git::commit_file_diff,
            git::discard_unstaged_file,
            git::discard_all_unstaged,
            git::stage_file,
            git::stage_all,
            git::unstage_file,
            git::unstage_all,
            git::commit_staged,
            git::merge_worktree_to_parent,
            github::github_auth_status,
            github::github_token,
            github::github_sign_out,
            github::set_github_setup_dismissed,
            github::github_use_cli_token,
            github::github_start_device_flow,
            github::github_poll_device_flow,
            github::github_repo_ref,
            github::github_default_pr_title,
            github::github_fetch_and_sync,
            github::github_pull_branch,
            github::github_sync_branch,
            github::github_push_branch,
            github::github_pr_file_diff,
            github::github_delete_remote_branch,
            ai::ai_status,
            ai::ai_auth_methods,
            ai::ai_set_api_key,
            ai::ai_logout,
            ai::ai_setup_dismissed,
            ai::set_ai_setup_dismissed,
            ai::ai_generate_commit_message,
            ai::ai_generate_pull_request_draft,
            ai::ai_commit_all_and_generate_pull_request_draft,
            ai::ai_login,
            ai::ai_login_respond,
            ai::ai_login_cancel,
            automations::register_automation_roots,
            automations::list_automations,
            automations::approve_automation,
            automations::reject_automation,
            automations::run_automation_now,
            automations::read_automation_source,
            automations::write_automation_source,
            browser::browser_create,
            browser::browser_frame_height,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_focus,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_devtools,
            browser::browser_clear_data,
            browser::browser_open_external,
            browser::browser_close,
            browser::browser_scroll,
            browser::browser_focus_element,
            browser::browser_click,
            browser::browser_eval,
            browser::browser_find_set,
            browser::browser_find_seek,
            browser::browser_find_clear,
            browser::browser_screenshot_tab,
            browser::browser_screenshot,
            browser::browser_snapshot,
            dev_bridge::__dev_bridge_result
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            let _ = (app_handle, event);
        });
}
