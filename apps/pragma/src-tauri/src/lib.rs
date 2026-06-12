mod db;
mod dev_bridge;
mod error;
mod git;
mod icons;
mod projects;
mod pty;
mod tabs;
mod worktrees;

use db::Db;
use pragma_constants::{AppInfo, CONSTANTS};
use pty::DaemonClient;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::Manager;

/// Returns the shared application info.
#[tauri::command]
fn app_info() -> AppInfo {
    CONSTANTS.app.clone()
}

/// Spawn a new PTY session via the daemon.
#[tauri::command]
fn pty_spawn(
    daemon: tauri::State<'_, DaemonClient>,
    session_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    daemon
        .spawn(session_id, cwd, cols, rows, on_event)
        .map_err(|e| e.to_string())
}

/// Attach to an existing daemon session with scrollback replay.
#[tauri::command]
fn pty_attach(
    daemon: tauri::State<'_, DaemonClient>,
    session_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    daemon
        .attach(session_id, cols, rows, on_event)
        .map_err(|e| e.to_string())
}

/// Write data to a PTY session.
#[tauri::command]
fn pty_write(
    daemon: tauri::State<'_, DaemonClient>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    daemon.write(&session_id, &data).map_err(|e| e.to_string())
}

/// Resize a PTY session.
#[tauri::command]
fn pty_resize(
    daemon: tauri::State<'_, DaemonClient>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    daemon
        .resize(&session_id, cols, rows)
        .map_err(|e| e.to_string())
}

/// Kill a PTY session.
#[tauri::command]
fn pty_kill(daemon: tauri::State<'_, DaemonClient>, session_id: String) -> Result<(), String> {
    daemon.kill(&session_id).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    if cfg!(debug_assertions) {
        builder = builder.invoke_handler(tauri::generate_handler![
            app_info,
            pty_spawn,
            pty_attach,
            pty_write,
            pty_resize,
            pty_kill,
            projects::list_projects,
            projects::add_project,
            projects::clone_project,
            projects::get_projects_directory,
            worktrees::list_worktrees,
            worktrees::create_worktree,
            tabs::list_tabs,
            tabs::create_tab,
            tabs::delete_tab,
            icons::project_icon,
            dev_bridge::__dev_bridge_result,
        ]);
    } else {
        builder = builder.invoke_handler(tauri::generate_handler![
            app_info,
            pty_spawn,
            pty_attach,
            pty_write,
            pty_resize,
            pty_kill,
            projects::list_projects,
            projects::add_project,
            projects::clone_project,
            projects::get_projects_directory,
            worktrees::list_worktrees,
            worktrees::create_worktree,
            tabs::list_tabs,
            tabs::create_tab,
            tabs::delete_tab,
            icons::project_icon,
        ]);
    }

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;

                if let Err(e) = dev_bridge::start_bridge(app.handle()) {
                    eprintln!("Warning: Failed to start dev bridge: {e}");
                }
            }

            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("app data dir should be available");

            let db_path = app_data_dir.join("pragma.db");
            let db = Db::open(db_path).expect("failed to open database");

            let socket_path = app_data_dir
                .join("daemon.sock")
                .to_string_lossy()
                .to_string();

            let daemon = DaemonClient::new(socket_path);

            let git_locks = Mutex::new(HashMap::<String, Mutex<()>>::new());

            app.manage(db);
            app.manage(daemon);
            app.manage(git_locks);

            log::info!(
                "Pragma supports up to {} parallel agents",
                CONSTANTS.max_parallel_agents.get()
            );

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(daemon) = app.try_state::<DaemonClient>() {
                    daemon.detach();
                }
            }
        });
}
