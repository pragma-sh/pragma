use std::path::PathBuf;

use pragma_constants::Worktree;

use crate::db::Db;
use crate::error::AppError;
use crate::git::{self, GitLocks};

/// List all worktrees for a project.
#[tauri::command]
pub fn list_worktrees(
    db: tauri::State<'_, Db>,
    project_id: String,
) -> Result<Vec<Worktree>, AppError> {
    db.list_worktrees(&project_id)
}

/// Create a new worktree branching from a parent worktree's HEAD.
#[tauri::command]
pub fn create_worktree(
    db: tauri::State<'_, Db>,
    git_locks: tauri::State<'_, GitLocks>,
    project_id: String,
    parent_worktree_id: String,
    branch: String,
    title: Option<String>,
) -> Result<Worktree, AppError> {
    let project = db
        .get_project(&project_id)?
        .ok_or_else(|| AppError::NotFound("project not found".into()))?;

    let parent = db
        .get_worktree(&parent_worktree_id)?
        .ok_or_else(|| AppError::NotFound("parent worktree not found".into()))?;

    let project_path = PathBuf::from(&project.path);

    let mut locks = git_locks.lock().unwrap();
    let _lock = locks
        .entry(project_id.clone())
        .or_insert_with(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap();

    let worktree_id = uuid::Uuid::new_v4().to_string();
    let wt_path = git::worktrees_dir(&project_path).join(&worktree_id);
    std::fs::create_dir_all(&wt_path)?;

    git::worktree_add(&PathBuf::from(&parent.path), &branch, &wt_path)?;

    let worktree = db.add_worktree(
        &worktree_id,
        &project.id,
        Some(&parent.id),
        &branch,
        title.as_deref(),
        &wt_path.to_string_lossy(),
        false,
    )?;

    drop(_lock);
    drop(locks);

    Ok(worktree)
}
