// Tauri command extraction requires owned IPC arguments and `State<T>` values.
#![allow(clippy::needless_pass_by_value)]

mod browser;
mod db;
#[allow(clippy::all, clippy::pedantic, dead_code)]
mod dev_bridge;
mod editors;
mod error;
mod fs;
mod git;
mod icons;
mod keybindings;
mod projects;
mod pty;
mod worktrees;

use pragma_constants::{
    AppInfo, DiffSide, KeybindingsConfig, ProjectIcon, Tab, TabKind, CONSTANTS,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{Emitter, Manager};

use crate::db::{Db, SplitLayout};
use crate::error::{AppError, AppResult};
use crate::git::GitLocks;
use crate::pty::PtyClient;

/// Menu item id for "Restart Daemon" in the Troubleshooting submenu.
const MENU_RESTART_DAEMON: &str = "troubleshooting.restart-daemon";
/// Menu item id for "Open Daemon Logs" in the Troubleshooting submenu.
const MENU_OPEN_DAEMON_LOGS: &str = "troubleshooting.open-daemon-logs";
/// Tauri event the menu emits to the frontend; payload is one of the menu ids
/// above. The frontend (`workspace-context`) listens and runs the action so the
/// resulting toast / tab lives where the rest of the UI does.
const MENU_EVENT: &str = "pragma:menu";

/// Installs the application menu — the OS default menu plus a Troubleshooting
/// submenu — and wires the submenu's clicks to the frontend. Used on both macOS
/// (global menu bar) and Linux (window menu). The handler only forwards the
/// action via `MENU_EVENT`; the actual restart/log-open runs through the typed
/// Tauri commands so feedback (toasts, the new tab) is uniform with the rest of
/// the UI.
fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let restart_daemon = MenuItem::with_id(
        app,
        MENU_RESTART_DAEMON,
        "Restart Daemon",
        true,
        None::<&str>,
    )?;
    let open_logs = MenuItem::with_id(
        app,
        MENU_OPEN_DAEMON_LOGS,
        "Open Daemon Logs",
        true,
        None::<&str>,
    )?;
    let troubleshooting =
        Submenu::with_items(app, "Troubleshooting", true, &[&restart_daemon, &open_logs])?;
    menu.append(&troubleshooting)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let action = event.id().as_ref();
        if action == MENU_RESTART_DAEMON || action == MENU_OPEN_DAEMON_LOGS {
            let _ = app.emit(MENU_EVENT, action);
        }
    });
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

#[tauri::command]
async fn pty_spawn(
    pty: tauri::State<'_, PtyClient>,
    session_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: Channel<InvokeResponseBody>,
) -> AppResult<()> {
    let client = pty.inner().clone();
    run_pty_task(move || client.spawn(session_id, cwd, cols, rows, on_event)).await
}

#[tauri::command]
async fn pty_attach(
    pty: tauri::State<'_, PtyClient>,
    session_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<InvokeResponseBody>,
) -> AppResult<()> {
    let client = pty.inner().clone();
    run_pty_task(move || client.attach(session_id, cols, rows, on_event)).await
}

#[tauri::command]
async fn pty_write(
    pty: tauri::State<'_, PtyClient>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    // Keystroke input is the latency-critical path. `write` only enqueues onto
    // the dedicated writer thread (no socket I/O, no daemon round-trip), so there
    // is nothing to offload — running it inline keeps every keystroke off the
    // blocking-pool scheduler entirely.
    pty.write(session_id, data)
}

#[tauri::command]
async fn pty_resize(
    pty: tauri::State<'_, PtyClient>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    let client = pty.inner().clone();
    run_pty_task(move || client.resize(session_id, cols, rows)).await
}

#[tauri::command]
async fn pty_kill(pty: tauri::State<'_, PtyClient>, session_id: String) -> AppResult<()> {
    let client = pty.inner().clone();
    run_pty_task(move || client.kill(session_id)).await
}

/// Asks the daemon to terminate every shell whose initial cwd is `path`.
/// Used as a safety net when a worktree is deleted from disk so the user's
/// running processes don't keep an open handle to a now-removed directory.
#[tauri::command]
async fn pty_kill_for_path(pty: tauri::State<'_, PtyClient>, path: String) -> AppResult<()> {
    let client = pty.inner().clone();
    run_pty_task(move || client.kill_for_cwd(path)).await
}

async fn run_pty_task(task: impl FnOnce() -> AppResult<()> + Send + 'static) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| AppError::Daemon(format!("pty task failed: {error}")))?
}

/// Restarts the detached PTY daemon (Troubleshooting menu). Kills the running
/// daemon and spawns a fresh build, terminating every running shell session.
#[tauri::command]
async fn restart_daemon(pty: tauri::State<'_, PtyClient>) -> AppResult<()> {
    let client = pty.inner().clone();
    run_pty_task(move || client.restart()).await
}

/// Returns the current contents of the daemon log file (empty if not yet
/// created). Backs the Troubleshooting menu's "Open Daemon Logs" tab.
#[tauri::command]
fn read_daemon_log(pty: tauri::State<'_, PtyClient>) -> AppResult<String> {
    pty.read_log()
}

#[tauri::command]
fn project_icon(db: tauri::State<'_, Db>, project_id: String) -> AppResult<Option<ProjectIcon>> {
    icons::project_icon(&db, project_id)
}

#[tauri::command]
fn list_tabs(db: tauri::State<'_, Db>, project_id: String) -> AppResult<Vec<Tab>> {
    db.list_tabs(&project_id)
}

// A tab carries enough locating data (kind/title/url/file/diff side) that the
// create command naturally takes more than clippy's default arg ceiling.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn create_tab(
    db: tauri::State<'_, Db>,
    project_id: String,
    worktree_id: String,
    kind: TabKind,
    title: Option<String>,
    url: Option<String>,
    file_path: Option<String>,
    diff_side: Option<DiffSide>,
) -> AppResult<Tab> {
    db.create_tab(
        &project_id,
        &worktree_id,
        kind,
        title,
        url,
        file_path,
        diff_side,
    )
}

#[tauri::command]
fn close_tab(db: tauri::State<'_, Db>, tab_id: String) -> AppResult<()> {
    db.delete_tab(&tab_id)
}

#[tauri::command]
fn rename_tab(db: tauri::State<'_, Db>, tab_id: String, title: String) -> AppResult<Tab> {
    db.rename_tab(&tab_id, &title)
}

/// Persists a shell-driven tab title (OSC 0/2) without touching the
/// `user_renamed` flag. The frontend reducer is responsible for refusing
/// to apply the update when the user has explicitly renamed the tab.
#[tauri::command]
fn set_tab_title(db: tauri::State<'_, Db>, tab_id: String, title: String) -> AppResult<Tab> {
    db.set_tab_title(&tab_id, &title)
}

/// Persists the current page URL for a browser tab (session restore).
#[tauri::command]
fn set_tab_url(db: tauri::State<'_, Db>, tab_id: String, url: String) -> AppResult<Tab> {
    db.set_tab_url(&tab_id, &url)
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
    app.manage(Db::open(app_data_dir.join("pragma.db"))?);
    // Isolate the dev daemon from prod by product identity (see `PtyClient::new`).
    app.manage(PtyClient::new(
        app_data_dir,
        app.config().product_name.as_deref(),
    ));
    app.manage(GitLocks::default());
    install_menu(app.handle())?;
    if let Err(error) = keybindings::load_or_ensure(app.path().home_dir()?) {
        log::warn!("failed to load keybindings config: {error}");
    }
    if cfg!(debug_assertions) {
        if let Err(error) = dev_bridge::start_bridge(app.handle()).map(|_| ()) {
            log::warn!("failed to start tauri-agent-tools dev bridge: {error}");
        }
    }
    log::info!(
        "Pragma supports up to {} parallel agents",
        CONSTANTS.max_parallel_agents
    );
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(setup_app)
        .invoke_handler(tauri::generate_handler![
            app_info,
            platform_name,
            load_keybindings,
            save_keybindings,
            pty_spawn,
            pty_attach,
            pty_write,
            pty_resize,
            pty_kill,
            pty_kill_for_path,
            restart_daemon,
            read_daemon_log,
            projects::list_projects,
            projects::add_project,
            projects::clone_project,
            projects::get_projects_directory,
            worktrees::list_worktrees,
            worktrees::create_worktree,
            worktrees::worktree_status,
            worktrees::rename_worktree,
            worktrees::hide_worktree,
            worktrees::delete_worktree,
            editors::open_worktree,
            project_icon,
            list_tabs,
            create_tab,
            close_tab,
            rename_tab,
            set_tab_title,
            set_tab_url,
            list_splits,
            set_split_layout,
            clear_split_layout,
            fs::list_dir_entries,
            fs::create_file,
            fs::create_folder,
            fs::path_exists,
            fs::read_file,
            fs::write_file,
            fs::rename_file,
            fs::delete_file,
            git::worktree_changes,
            git::worktrees_merged_status,
            git::file_diff,
            git::discard_unstaged_file,
            git::discard_all_unstaged,
            git::stage_file,
            git::stage_all,
            git::unstage_file,
            git::unstage_all,
            git::commit_staged,
            git::merge_worktree_to_parent,
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
            browser::browser_screenshot,
            browser::browser_snapshot,
            dev_bridge::__dev_bridge_result
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
