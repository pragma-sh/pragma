use std::path::PathBuf;

use pragma_constants::Worktree;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::git::{self, GitLocks};

#[tauri::command]
pub fn list_worktrees(db: State<'_, Db>, project_id: String) -> AppResult<Vec<Worktree>> {
    db.list_worktrees(&project_id)
}

#[tauri::command]
pub fn create_worktree(
    db: State<'_, Db>,
    locks: State<'_, GitLocks>,
    project_id: String,
    parent_worktree_id: String,
    branch: String,
    title: Option<String>,
) -> AppResult<Worktree> {
    if branch.trim().is_empty() {
        return Err(AppError::InvalidInput("branch is required".to_string()));
    }
    let project = db.project(&project_id)?;
    let parent = db.worktree(&parent_worktree_id)?;
    let lock = locks.lock_for(&project_id)?;
    let _guard = lock.lock()?;
    git::ensure_pragma_excluded(PathBuf::from(&project.path).as_path())?;
    let worktree_id = uuid::Uuid::new_v4().to_string();
    let path = PathBuf::from(&project.path)
        .join(".pragma/worktrees")
        .join(&worktree_id);
    git::create_worktree(PathBuf::from(&parent.path).as_path(), branch.trim(), &path)?;
    db.insert_worktree(
        &project_id,
        &parent_worktree_id,
        branch.trim(),
        title.filter(|value| !value.trim().is_empty()),
        &path.to_string_lossy(),
    )
}
