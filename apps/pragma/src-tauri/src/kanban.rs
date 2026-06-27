//! Tauri commands backing the project-scoped prompt Kanban board. The board's
//! cards persist in `SQLite` (see `db.rs`); these commands are thin CRUD wrappers
//! plus a dedicated status move, mirroring the split-layout persistence pattern.

use pragma_constants::{KanbanPromptCard, KanbanPromptStatus};
use tauri::State;

use crate::db::Db;
use crate::error::AppResult;

/// Lists a project's Kanban prompt cards.
#[tauri::command]
pub fn list_kanban_cards(
    db: State<'_, Db>,
    project_id: String,
) -> AppResult<Vec<KanbanPromptCard>> {
    db.list_kanban_cards(&project_id)
}

/// Creates a fresh draft card scoped to a project.
#[tauri::command]
pub fn create_kanban_card(
    db: State<'_, Db>,
    project_id: String,
    branch_name: String,
    prompt: String,
    agent_id: String,
    model_id: Option<String>,
) -> AppResult<KanbanPromptCard> {
    db.create_kanban_card(
        &project_id,
        &branch_name,
        &prompt,
        &agent_id,
        model_id.as_deref(),
    )
}

/// Persists every mutable field of a card (draft edits and status transitions).
#[tauri::command]
pub fn update_kanban_card(
    db: State<'_, Db>,
    card: KanbanPromptCard,
) -> AppResult<KanbanPromptCard> {
    db.update_kanban_card(&card)
}

/// Moves a card to a different column (status only).
#[tauri::command]
pub fn move_kanban_card(
    db: State<'_, Db>,
    id: String,
    status: KanbanPromptStatus,
) -> AppResult<KanbanPromptCard> {
    db.move_kanban_card(&id, status)
}

/// Deletes a card.
#[tauri::command]
pub fn delete_kanban_card(db: State<'_, Db>, id: String) -> AppResult<()> {
    db.delete_kanban_card(&id)
}
