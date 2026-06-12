use pragma_constants::Tab;

use crate::db::Db;
use crate::error::AppError;

/// List the persisted tabs for a project, ordered by their position.
#[tauri::command]
pub fn list_tabs(db: tauri::State<'_, Db>, project_id: String) -> Result<Vec<Tab>, AppError> {
    db.list_tabs(&project_id)
}

/// Persist a tab. The tab `id` is the daemon `sessionId`, so reattach can
/// reconnect to the still-running shell on relaunch.
#[tauri::command]
pub fn create_tab(
    db: tauri::State<'_, Db>,
    id: String,
    project_id: String,
    worktree_id: String,
    title: Option<String>,
    order_index: i64,
) -> Result<Tab, AppError> {
    db.add_tab(
        &id,
        &project_id,
        &worktree_id,
        title.as_deref(),
        order_index,
    )
}

/// Remove a persisted tab (called when the user closes it).
#[tauri::command]
pub fn delete_tab(db: tauri::State<'_, Db>, id: String) -> Result<(), AppError> {
    db.delete_tab(&id)
}
