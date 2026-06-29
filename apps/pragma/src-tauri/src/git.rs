//! Git commands.
//!
//! Two layers live here. **Lifecycle** helpers (`ensure_repo`, `current_branch`,
//! `clone`, `create_worktree`, `remove_worktree`, …) run locally on the client —
//! they manage the on-disk worktrees the client tracks in its DB. The
//! **Changes-view** commands (`worktree_changes`, `file_diff`, staging, commit,
//! merge) are thin forwarders: they resolve the trusted worktree root and the
//! DB-derived parent branch, then send a `git` RPC to the project's host
//! (`pragma-core`), which runs git against its own disk. That host is the local
//! managed server for local projects and the remote `pragma-server` over the SSH
//! bridge for remote ones.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use pragma_constants::{
    ChangeStatus, DiffSide, FileDiff, ProtocolRpcMethod, Worktree, WorktreeChanges,
};
use pragma_core::git::{GitRequest, MergedStatusItem};
use serde::de::DeserializeOwned;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::hosts::Hosts;
use crate::pty::PtyClient;

const PRAGMA_WORKTREES_EXCLUDE: &str = ".pragma/worktrees/";

#[derive(Default)]
pub struct GitLocks(Mutex<HashMap<String, Arc<Mutex<()>>>>);

impl GitLocks {
    pub fn lock_for(&self, project_id: &str) -> AppResult<Arc<Mutex<()>>> {
        let mut locks = self.0.lock()?;
        Ok(Arc::clone(
            locks
                .entry(project_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        ))
    }
}

// ---------------------------------------------------------------------------
// Changes-view commands — forwarded to the project host via the `git` RPC.
// ---------------------------------------------------------------------------

/// Sends a `git` RPC and decodes its JSON response into `T`.
fn git_rpc<T: DeserializeOwned>(pty: &PtyClient, request: &GitRequest) -> AppResult<T> {
    let payload = serde_json::to_value(request)?;
    let value = pty.rpc(ProtocolRpcMethod::Git, payload)?;
    Ok(serde_json::from_value(value)?)
}

/// Resolves a worktree's parent branch from the DB, or `None` for a
/// parentless/main worktree. The host needs this to compute the fork point.
fn parent_branch(db: &Db, worktree: &Worktree) -> AppResult<Option<String>> {
    match worktree.parent_id.as_deref() {
        Some(parent_id) => Ok(Some(db.worktree(parent_id)?.branch)),
        None => Ok(None),
    }
}

/// Lists a worktree's committed/staged/unstaged changes.
#[tauri::command]
pub fn worktree_changes(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
) -> AppResult<WorktreeChanges> {
    let worktree = db.worktree(&worktree_id)?;
    let parent_branch = parent_branch(&db, &worktree)?;
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    git_rpc(
        &pty,
        &GitRequest::WorktreeChanges {
            root: worktree.path,
            parent_branch,
        },
    )
}

/// Reports, for each requested worktree, whether it is fully merged & clean. A
/// transport failure yields an empty map so a momentarily-unreachable host never
/// fails the sidebar's polling batch.
#[tauri::command]
pub fn worktrees_merged_status(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_ids: Vec<String>,
) -> HashMap<String, bool> {
    // The sidebar polls merged status per project, so every id in a batch shares
    // a host; resolve once from the first id and fall back to local if its host
    // is momentarily unreachable.
    let client = match worktree_ids.first() {
        Some(first) => hosts
            .for_worktree(&db, first)
            .unwrap_or_else(|_| hosts.local()),
        None => return HashMap::new(),
    };
    let mut items = Vec::new();
    for id in worktree_ids {
        let Ok(worktree) = db.worktree(&id) else {
            continue;
        };
        let parent = parent_branch(&db, &worktree).ok().flatten();
        items.push(MergedStatusItem {
            id,
            root: worktree.path,
            branch: worktree.branch,
            parent_branch: parent,
        });
    }
    git_rpc(&client, &GitRequest::MergedStatus { items }).unwrap_or_default()
}

/// Loads the old/new text for a single changed file on the given diff side.
#[tauri::command]
pub fn file_diff(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    path: String,
    side: DiffSide,
    old_path: Option<String>,
) -> AppResult<FileDiff> {
    let worktree = db.worktree(&worktree_id)?;
    let parent_branch = parent_branch(&db, &worktree)?;
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    git_rpc(
        &pty,
        &GitRequest::FileDiff {
            root: worktree.path,
            path,
            side,
            old_path,
            parent_branch,
        },
    )
}

/// PR-style three-dot diff (`base...HEAD`) for one file, run on the repo's host.
pub fn pr_file_diff(
    pty: &PtyClient,
    root: &Path,
    base: &str,
    path: &str,
    old_path: Option<&str>,
) -> AppResult<FileDiff> {
    git_rpc(
        pty,
        &GitRequest::PrFileDiff {
            root: path_string(root),
            base: base.to_string(),
            path: path.to_string(),
            old_path: old_path.map(str::to_string),
        },
    )
}

/// Discards a single unstaged change. **Destructive and irreversible.**
#[tauri::command]
pub fn discard_unstaged_file(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    path: String,
    status: ChangeStatus,
    old_path: Option<String>,
) -> AppResult<()> {
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    let root = db.worktree(&worktree_id)?.path;
    git_rpc(
        &pty,
        &GitRequest::DiscardUnstagedFile {
            root,
            path,
            status,
            old_path,
        },
    )
}

/// Discards every unstaged change in the worktree. **Destructive.**
#[tauri::command]
pub fn discard_all_unstaged(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
) -> AppResult<()> {
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    let root = db.worktree(&worktree_id)?.path;
    git_rpc(&pty, &GitRequest::DiscardAllUnstaged { root })
}

/// Stages a single change into the index (`git add`).
#[tauri::command]
pub fn stage_file(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    path: String,
) -> AppResult<()> {
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    let root = db.worktree(&worktree_id)?.path;
    git_rpc(&pty, &GitRequest::StageFile { root, path })
}

/// Stages every change in the worktree (`git add -A`).
#[tauri::command]
pub fn stage_all(db: State<'_, Db>, hosts: State<'_, Hosts>, worktree_id: String) -> AppResult<()> {
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    let root = db.worktree(&worktree_id)?.path;
    git_rpc(&pty, &GitRequest::StageAll { root })
}

/// Unstages a single change from the index, leaving the working tree untouched.
#[tauri::command]
pub fn unstage_file(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    path: String,
    old_path: Option<String>,
) -> AppResult<()> {
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    let root = db.worktree(&worktree_id)?.path;
    git_rpc(
        &pty,
        &GitRequest::UnstageFile {
            root,
            path,
            old_path,
        },
    )
}

/// Unstages every staged change, resetting the index to HEAD (`git reset`).
#[tauri::command]
pub fn unstage_all(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
) -> AppResult<()> {
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    let root = db.worktree(&worktree_id)?.path;
    git_rpc(&pty, &GitRequest::UnstageAll { root })
}

/// Creates a commit from the worktree's staged changes (`git commit -m`).
#[tauri::command]
pub fn commit_staged(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    message: String,
) -> AppResult<()> {
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    let root = db.worktree(&worktree_id)?.path;
    git_rpc(&pty, &GitRequest::CommitStaged { root, message })
}

/// Merges a child worktree's branch into its recorded parent worktree. The
/// per-project lock is held client-side so concurrent merges on the same project
/// serialize even though the merge itself runs on the host.
#[tauri::command]
pub fn merge_worktree_to_parent(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    locks: State<'_, GitLocks>,
    worktree_id: String,
) -> AppResult<()> {
    let worktree = db.worktree(&worktree_id)?;
    if worktree.is_main {
        return Err(AppError::InvalidInput(
            "cannot merge the main worktree into a parent".to_string(),
        ));
    }
    let Some(parent_id) = worktree.parent_id.as_deref() else {
        return Err(AppError::InvalidInput(
            "worktree has no parent to merge into".to_string(),
        ));
    };
    let parent = db.worktree(parent_id)?;
    let lock = locks.lock_for(&worktree.project_id)?;
    let _guard = lock.lock()?;
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    git_rpc(
        &pty,
        &GitRequest::MergeWorktreeToParent {
            parent_root: parent.path,
            parent_branch: parent.branch,
            child_root: worktree.path,
            child_branch: worktree.branch,
        },
    )
}

// ---------------------------------------------------------------------------
// Lifecycle helpers — run locally on the client to manage on-disk worktrees.
// ---------------------------------------------------------------------------

pub fn ensure_repo(path: &Path) -> AppResult<()> {
    let output = Command::new("git")
        .args([
            "-C",
            path_string(path).as_str(),
            "rev-parse",
            "--show-toplevel",
        ])
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(AppError::Git(stderr(output.stderr)))
    }
}

pub fn current_branch(path: &Path) -> AppResult<String> {
    let output = Command::new("git")
        .args(["-C", path_string(path).as_str(), "branch", "--show-current"])
        .output()?;
    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if branch.is_empty() {
            "HEAD".to_string()
        } else {
            branch
        })
    } else {
        Err(AppError::Git(stderr(output.stderr)))
    }
}

pub fn clone(remote_url: &str, into_directory: &Path) -> AppResult<PathBuf> {
    std::fs::create_dir_all(into_directory)?;
    let repo_name = remote_url
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .unwrap_or("project")
        .trim_end_matches(".git");
    let target = into_directory.join(repo_name);
    let output = Command::new("git")
        .args(["clone", remote_url, path_string(&target).as_str()])
        .output()?;
    if output.status.success() {
        Ok(target)
    } else {
        Err(AppError::Git(stderr(output.stderr)))
    }
}

pub fn ensure_pragma_excluded(project_path: &Path) -> AppResult<()> {
    let exclude = project_path.join(".git/info/exclude");
    if let Some(parent) = exclude.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    let mut has_worktrees_exclude = false;
    let mut changed = false;
    let mut lines = Vec::new();
    for line in existing.lines() {
        match line.trim() {
            ".pragma/" => changed = true,
            PRAGMA_WORKTREES_EXCLUDE => {
                has_worktrees_exclude = true;
                lines.push(line.to_string());
            }
            _ => lines.push(line.to_string()),
        }
    }
    if !has_worktrees_exclude {
        lines.push(PRAGMA_WORKTREES_EXCLUDE.to_string());
        changed = true;
    }
    if changed {
        std::fs::write(exclude, format!("{}\n", lines.join("\n")))?;
    }
    Ok(())
}

pub fn create_worktree(parent_path: &Path, branch: &str, path: &Path) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let output = Command::new("git")
        .args([
            "-C",
            path_string(parent_path).as_str(),
            "worktree",
            "add",
            "-b",
            branch,
            path_string(path).as_str(),
        ])
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(AppError::Git(stderr(output.stderr)))
    }
}

/// True when the worktree has uncommitted changes, staged changes, or untracked
/// files. Used by the delete confirmation dialog.
pub fn worktree_is_dirty(path: &Path) -> bool {
    let output = Command::new("git")
        .args([
            "-C",
            path_string(path).as_str(),
            "status",
            "--porcelain",
            "--untracked-files=normal",
        ])
        .output();
    match output {
        Ok(out) if out.status.success() => !out.stdout.is_empty(),
        _ => true,
    }
}

/// Removes a worktree from disk via `git worktree remove`. Tolerates a worktree
/// whose admin state drifted: prunes stale entries, removes any orphaned
/// directory, and returns `Ok` so the caller can still delete the DB row.
pub fn remove_worktree(repo_path: &Path, worktree_path: &Path, force: bool) -> AppResult<()> {
    if !worktree_path.exists() {
        prune_worktrees(repo_path)?;
        return Ok(());
    }
    let mut args: Vec<String> = vec![
        "-C".to_string(),
        path_string(repo_path),
        "worktree".to_string(),
        "remove".to_string(),
    ];
    if force {
        args.push("--force".to_string());
    }
    args.push(path_string(worktree_path));
    let output = Command::new("git").args(&args).output()?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("not a working tree") || stderr.contains("not a git worktree") {
        prune_worktrees(repo_path)?;
        if worktree_path.exists() {
            if let Err(error) = std::fs::remove_dir_all(worktree_path) {
                log::warn!(
                    "failed to remove orphaned worktree directory {}: {error}",
                    worktree_path.display()
                );
            }
        }
        return Ok(());
    }
    Err(AppError::Git(stderr.trim().to_string()))
}

/// Prunes stale worktree administrative entries (`git worktree prune`).
fn prune_worktrees(repo_path: &Path) -> AppResult<()> {
    let output = Command::new("git")
        .args(["-C", path_string(repo_path).as_str(), "worktree", "prune"])
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(AppError::Git(stderr(output.stderr)))
    }
}

/// Hard-deletes a branch ref via `git branch -D <name>`.
pub fn delete_branch(path: &Path, branch: &str) -> AppResult<()> {
    let output = Command::new("git")
        .args(["-C", path_string(path).as_str(), "branch", "-D", branch])
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(AppError::Git(stderr(output.stderr)))
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn stderr(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_string()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use tempfile::tempdir;

    use super::{
        current_branch, ensure_pragma_excluded, ensure_repo, remove_worktree, worktree_is_dirty,
        PRAGMA_WORKTREES_EXCLUDE,
    };

    fn run(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git command");
        assert!(output.status.success(), "git {args:?} failed");
    }

    /// Builds a repo with one committed file plus a linked `feature` worktree and
    /// returns `(main_path, child_path)`, leaking the temp guards for the test.
    fn repo_with_worktree() -> (PathBuf, PathBuf) {
        let main = tempdir().expect("tempdir");
        let main_path = main.path().to_path_buf();
        run(&main_path, &["init", "-b", "main"]);
        run(&main_path, &["config", "user.email", "test@example.com"]);
        run(&main_path, &["config", "user.name", "Test"]);
        std::fs::write(main_path.join("base.txt"), "base\n").expect("write base");
        run(&main_path, &["add", "-A"]);
        run(&main_path, &["commit", "-m", "base"]);

        let child_root = tempdir().expect("child tempdir");
        let child_path = child_root.path().join("wt");
        run(
            &main_path,
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                child_path.to_string_lossy().as_ref(),
            ],
        );
        std::mem::forget(main);
        std::mem::forget(child_root);
        (main_path, child_path)
    }

    #[test]
    fn validates_repo_and_branch() {
        let dir = tempdir().expect("tempdir");
        run(dir.path(), &["init", "-b", "main"]);
        ensure_repo(dir.path()).expect("repo should validate");
        assert_eq!(current_branch(dir.path()).expect("branch"), "main");
    }

    #[test]
    fn appends_pragma_exclude_once() {
        let dir = tempdir().expect("tempdir");
        run(dir.path(), &["init"]);
        ensure_pragma_excluded(dir.path()).expect("exclude");
        ensure_pragma_excluded(dir.path()).expect("exclude");
        let exclude =
            std::fs::read_to_string(dir.path().join(".git/info/exclude")).expect("exclude file");
        assert_eq!(
            exclude
                .lines()
                .filter(|line| line.trim() == PRAGMA_WORKTREES_EXCLUDE)
                .count(),
            1
        );
    }

    #[test]
    fn migrates_broad_pragma_exclude_to_worktrees_only() {
        let dir = tempdir().expect("tempdir");
        run(dir.path(), &["init"]);
        let exclude_path = dir.path().join(".git/info/exclude");
        std::fs::write(&exclude_path, "*.log\n.pragma/\n").expect("write exclude");

        ensure_pragma_excluded(dir.path()).expect("exclude");

        let exclude = std::fs::read_to_string(exclude_path).expect("exclude file");
        assert!(exclude.lines().any(|line| line.trim() == "*.log"));
        assert!(exclude
            .lines()
            .any(|line| line.trim() == PRAGMA_WORKTREES_EXCLUDE));
        assert!(!exclude.lines().any(|line| line.trim() == ".pragma/"));
    }

    #[test]
    fn dirty_signal_tracks_untracked_files() {
        let dir = tempdir().expect("tempdir");
        run(dir.path(), &["init", "-b", "main"]);
        assert!(!worktree_is_dirty(dir.path()));
        std::fs::write(dir.path().join("scratch.txt"), "todo").expect("write");
        assert!(worktree_is_dirty(dir.path()));
    }

    #[test]
    fn remove_worktree_succeeds_when_directory_already_gone() {
        let (main_path, child_path) = repo_with_worktree();
        std::fs::remove_dir_all(&child_path).expect("remove child dir");
        remove_worktree(&main_path, &child_path, false).expect("remove should succeed");
    }

    #[test]
    fn remove_worktree_succeeds_when_admin_state_drifted() {
        let (main_path, child_path) = repo_with_worktree();
        run(&main_path, &["worktree", "prune"]);
        assert!(child_path.exists(), "child dir should still be on disk");
        remove_worktree(&main_path, &child_path, false).expect("remove should succeed");
        assert!(!child_path.exists(), "orphaned dir should be removed");
    }
}
