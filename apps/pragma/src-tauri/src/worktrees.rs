use std::path::PathBuf;

use pragma_constants::{Worktree, WorktreeStatus};
use pragma_core::git::GitRequest;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::git::{self, GitLocks};
use crate::hosts::Hosts;
use crate::scripts;

#[tauri::command]
pub fn list_worktrees(db: State<'_, Db>, project_id: String) -> AppResult<Vec<Worktree>> {
    db.list_worktrees(&project_id)
}

#[tauri::command]
pub fn create_worktree(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
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
    let pty = hosts.for_project(&db, &project_id)?;
    git::host_rpc::<()>(
        &pty,
        &GitRequest::EnsurePragmaExcluded {
            project_root: project.path.clone(),
        },
    )?;
    let worktree_id = uuid::Uuid::new_v4().to_string();
    let path = PathBuf::from(&project.path)
        .join(".pragma/worktrees")
        .join(&worktree_id);
    let path = path.to_string_lossy().into_owned();
    git::host_rpc::<()>(
        &pty,
        &GitRequest::CreateWorktree {
            parent_root: parent.path.clone(),
            branch: branch.trim().to_string(),
            path: path.clone(),
        },
    )?;
    let worktree = db.insert_worktree(
        &worktree_id,
        &project_id,
        &parent_worktree_id,
        branch.trim(),
        title.filter(|value| !value.trim().is_empty()),
        &path,
    )?;
    let config = scripts::load_project_scripts_on_host(&pty, &project.path)?;
    scripts::run_headless_commands(&pty, &project, &worktree, "setup", config.setup.as_slice())?;
    Ok(worktree)
}

/// True when the worktree has uncommitted, staged, or untracked changes.
/// Used by the delete confirmation dialog to warn the user.
#[tauri::command]
pub fn worktree_status(
    worktree_id: String,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
) -> AppResult<WorktreeStatus> {
    let worktree = db.worktree(&worktree_id)?;
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    let dirty = git::host_rpc(
        &pty,
        &GitRequest::IsDirty {
            root: worktree.path,
        },
    )?;
    Ok(WorktreeStatus { dirty })
}

/// Updates the optional display title for a worktree. An empty string clears
/// the title so the branch name is shown again.
#[tauri::command]
pub fn rename_worktree(
    worktree_id: String,
    title: Option<String>,
    db: State<'_, Db>,
) -> AppResult<Worktree> {
    db.rename_worktree(&worktree_id, title.as_deref())
}

/// Toggles the `hidden` flag on a worktree — the row stays on disk, but the
/// sidebar filters it out. Persists across restarts.
#[tauri::command]
pub fn hide_worktree(worktree_id: String, hidden: bool, db: State<'_, Db>) -> AppResult<Worktree> {
    db.set_worktree_hidden(&worktree_id, hidden)
}

/// Removes a worktree from disk, optionally deletes its branch, terminates
/// every running shell in the worktree, and finally hard-deletes the row
/// (cascading to its tabs and child worktrees).
///
/// Sequence matters: we tear down the PTY sessions *before* removing the
/// directory so the shells don't have an open handle to a now-vanished cwd.
#[tauri::command]
pub fn delete_worktree(
    worktree_id: String,
    delete_branch: bool,
    force: bool,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    locks: State<'_, GitLocks>,
) -> AppResult<()> {
    let worktree = db.worktree(&worktree_id)?;
    if worktree.is_main {
        return Err(AppError::InvalidInput(
            "cannot delete the main worktree".to_string(),
        ));
    }
    let project = db.project(&worktree.project_id)?;
    let lock = locks.lock_for(&worktree.project_id)?;
    let _guard = lock.lock()?;
    let pty = hosts.for_project(&db, &worktree.project_id)?;

    let config = scripts::load_project_scripts_on_host(&pty, &project.path)?;
    scripts::run_headless_commands(
        &pty,
        &project,
        &worktree,
        "teardown",
        config.teardown.as_slice(),
    )?;

    // Terminate any PTY sessions in this worktree so they don't keep an open
    // fd on the directory we're about to remove. Best-effort: a daemon hiccup
    // shouldn't block the delete, since the user already asked for it.
    if let Err(error) = pty.kill_for_cwd(worktree.path.clone()) {
        log::warn!("failed to kill sessions for {}: {error}", worktree.path);
    }

    git::host_rpc::<()>(
        &pty,
        &GitRequest::RemoveWorktree {
            repo_root: project.path.clone(),
            worktree_path: worktree.path.clone(),
            force,
        },
    )?;

    if delete_branch {
        // Branch deletion must run from a worktree that *doesn't* have the
        // branch checked out. Fall back to any other worktree in the project
        // before finally giving up. The main worktree is the natural choice.
        let siblings = db.list_worktrees(&worktree.project_id)?;
        let other = siblings
            .iter()
            .find(|candidate| candidate.id != worktree_id && candidate.branch != worktree.branch);
        if let Some(candidate) = other {
            if let Err(error) = git::host_rpc::<()>(
                &pty,
                &GitRequest::DeleteBranch {
                    repo_root: candidate.path.clone(),
                    branch: worktree.branch.clone(),
                },
            ) {
                log::warn!(
                    "failed to delete branch {} from {}: {error}",
                    worktree.branch,
                    candidate.path
                );
            }
        }
    }

    db.delete_worktree(&worktree_id)?;
    Ok(())
}
