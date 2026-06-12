use pragma_constants::{AppInfo, CONSTANTS};

/// Returns the shared application info (name, identifier, version).
///
/// Backed by `@pragma/constants`, so the value is identical to what the
/// frontend imports — one source of truth across the language boundary.
#[tauri::command]
fn app_info() -> AppInfo {
    CONSTANTS.app.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Same shared scalar constant the frontend reads (constants.maxParallelAgents).
            log::info!(
                "Pragma supports up to {} parallel agents",
                CONSTANTS.max_parallel_agents
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
