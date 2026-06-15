// Tauri command extraction requires owned IPC arguments and `State<T>` values.
#![allow(clippy::needless_pass_by_value)]

mod browser;
mod db;
#[allow(clippy::all, clippy::pedantic, dead_code)]
mod dev_bridge;
mod editors;
mod error;
mod git;
mod icons;
mod keybindings;
mod projects;
mod pty;
mod worktrees;

use pragma_constants::{AppInfo, KeybindingsConfig, ProjectIcon, Tab, TabKind, CONSTANTS};
use tauri::ipc::Channel;
use tauri::Manager;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::git::GitLocks;
use crate::pty::{PtyClient, PtyEvent};

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
    on_event: Channel<PtyEvent>,
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
    on_event: Channel<PtyEvent>,
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
    let client = pty.inner().clone();
    run_pty_task(move || client.write(session_id, data)).await
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

#[tauri::command]
fn project_icon(db: tauri::State<'_, Db>, project_id: String) -> AppResult<Option<ProjectIcon>> {
    icons::project_icon(&db, project_id)
}

#[tauri::command]
fn list_tabs(db: tauri::State<'_, Db>, project_id: String) -> AppResult<Vec<Tab>> {
    db.list_tabs(&project_id)
}

#[tauri::command]
fn create_tab(
    db: tauri::State<'_, Db>,
    project_id: String,
    worktree_id: String,
    kind: TabKind,
    title: Option<String>,
    url: Option<String>,
) -> AppResult<Tab> {
    db.create_tab(&project_id, &worktree_id, kind, title, url)
}

#[tauri::command]
fn close_tab(db: tauri::State<'_, Db>, tab_id: String) -> AppResult<()> {
    db.delete_tab(&tab_id)
}

#[tauri::command]
fn rename_tab(db: tauri::State<'_, Db>, tab_id: String, title: String) -> AppResult<Tab> {
    db.rename_tab(&tab_id, &title)
}

/// Persists the current page URL for a browser tab (session restore).
#[tauri::command]
fn set_tab_url(db: tauri::State<'_, Db>, tab_id: String, url: String) -> AppResult<Tab> {
    db.set_tab_url(&tab_id, &url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let app_data_dir = app.path().app_data_dir()?;
            app.manage(Db::open(app_data_dir.join("pragma.db"))?);
            app.manage(PtyClient::new(app_data_dir));
            app.manage(GitLocks::default());
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
        })
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
            set_tab_url,
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
