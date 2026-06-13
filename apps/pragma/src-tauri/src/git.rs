use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use crate::error::{AppError, AppResult};

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
    if !existing.lines().any(|line| line.trim() == ".pragma/") {
        std::fs::write(exclude, format!("{existing}\n.pragma/\n"))?;
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
/// files. `git status --porcelain` is the canonical source — we use the
/// per-worktree `-C` form so this can be called from anywhere on disk.
pub fn worktree_is_dirty(path: &Path) -> bool {
    // `git status --porcelain` is slow on large repos. `--porcelain` with `-uno`
    // would miss untracked files; we want a *strict* signal here, so we accept
    // the cost. The check only runs when the user opens the destructive dialog.
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
        // If git can't even open the worktree, surface it as dirty so the
        // destructive action is gated behind an explicit "I understand" click.
        _ => true,
    }
}

/// Removes a worktree from disk via `git worktree remove`. Refuses to be lossy
/// unless `force` is true; in that case `--force` is appended so partially-dirty
/// worktrees can still be torn down (the UI is expected to warn first).
pub fn remove_worktree(repo_path: &Path, worktree_path: &Path, force: bool) -> AppResult<()> {
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
        Ok(())
    } else {
        Err(AppError::Git(stderr(output.stderr)))
    }
}

/// Hard-deletes a branch ref via `git branch -D <name>`. Must be invoked from
/// inside a worktree that does *not* currently have `branch` checked out.
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
    use std::process::Command;

    use tempfile::tempdir;

    use super::{current_branch, ensure_pragma_excluded, ensure_repo, worktree_is_dirty};

    #[test]
    fn validates_repo_and_branch() {
        let dir = tempdir().expect("tempdir");
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(dir.path())
            .output()
            .expect("git init");
        ensure_repo(dir.path()).expect("repo should validate");
        assert_eq!(current_branch(dir.path()).expect("branch"), "main");
    }

    #[test]
    fn appends_pragma_exclude_once() {
        let dir = tempdir().expect("tempdir");
        Command::new("git")
            .arg("init")
            .current_dir(dir.path())
            .output()
            .expect("git init");
        ensure_pragma_excluded(dir.path()).expect("exclude");
        ensure_pragma_excluded(dir.path()).expect("exclude");
        let exclude =
            std::fs::read_to_string(dir.path().join(".git/info/exclude")).expect("exclude file");
        assert_eq!(
            exclude
                .lines()
                .filter(|line| line.trim() == ".pragma/")
                .count(),
            1
        );
    }

    #[test]
    fn clean_worktree_is_not_dirty() {
        let dir = tempdir().expect("tempdir");
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(dir.path())
            .output()
            .expect("git init");
        assert!(!worktree_is_dirty(dir.path()));
    }

    #[test]
    fn untracked_files_mark_worktree_dirty() {
        let dir = tempdir().expect("tempdir");
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(dir.path())
            .output()
            .expect("git init");
        std::fs::write(dir.path().join("scratch.txt"), "todo").expect("write");
        assert!(worktree_is_dirty(dir.path()));
    }
}
