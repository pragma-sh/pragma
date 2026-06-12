use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use crate::error::AppError;

/// Per-project mutex to serialize mutating git operations.
pub type GitLocks = Mutex<HashMap<String, Mutex<()>>>;

/// Run a git command in the given directory with the given arguments.
/// Returns stdout as a string, or an `AppError` with stderr.
fn run_git(dir: &Path, args: &[&str]) -> Result<String, AppError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| AppError::Git(format!("failed to run git: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Git(stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Check if the given path is inside a git repository.
pub fn is_repo(path: &Path) -> bool {
    run_git(path, &["rev-parse", "--git-dir"]).is_ok()
}

/// Get the current branch name for a repo.
pub fn current_branch(path: &Path) -> Result<String, AppError> {
    run_git(path, &["rev-parse", "--abbrev-ref", "HEAD"])
}

/// Clone a remote repository into the given directory.
pub fn clone(remote_url: &str, into_dir: &Path) -> Result<(), AppError> {
    let parent = into_dir
        .parent()
        .ok_or_else(|| AppError::Invalid("no parent directory".into()))?;
    run_git(parent, &["clone", remote_url, &into_dir.to_string_lossy()])?;
    Ok(())
}

/// Add a new git worktree.
///
/// Creates a worktree at `path`, branching from the given parent worktree's HEAD
/// with the given branch name.
pub fn worktree_add(parent_path: &Path, branch: &str, path: &Path) -> Result<(), AppError> {
    run_git(
        parent_path,
        &["worktree", "add", "-b", branch, &path.to_string_lossy()],
    )?;
    Ok(())
}

/// Remove a git worktree.
pub fn worktree_remove(project_path: &Path, worktree_path: &Path) -> Result<(), AppError> {
    run_git(
        project_path,
        &[
            "worktree",
            "remove",
            &worktree_path.to_string_lossy(),
            "--force",
        ],
    )?;
    Ok(())
}

/// Ensure `.pragma/` is in `.git/info/exclude` so worktree checkouts don't dirty the repo.
pub fn ensure_pragma_excluded(path: &Path) -> Result<(), AppError> {
    let exclude_path = path.join(".git/info/exclude");
    if !exclude_path.exists() {
        return Ok(());
    }

    let content = std::fs::read_to_string(&exclude_path).unwrap_or_default();
    let pragma_entry = ".pragma/";

    if content.lines().any(|line| line.trim() == pragma_entry) {
        return Ok(());
    }

    let mut new_content = content;
    if !new_content.ends_with('\n') {
        new_content.push('\n');
    }
    new_content.push_str(pragma_entry);
    new_content.push('\n');

    std::fs::write(&exclude_path, new_content)?;
    Ok(())
}

/// Get the worktrees directory for a project.
pub fn worktrees_dir(project_path: &Path) -> PathBuf {
    project_path.join(".pragma/worktrees")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn init_test_repo() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        run_git(&path, &["init"]).unwrap();
        run_git(&path, &["config", "user.email", "test@test.com"]).unwrap();
        run_git(&path, &["config", "user.name", "Test"]).unwrap();
        fs::write(path.join("README.md"), "# test").unwrap();
        run_git(&path, &["add", "README.md"]).unwrap();
        run_git(&path, &["commit", "-m", "init"]).unwrap();
        (dir, path)
    }

    #[test]
    fn is_repo_detects_git_dir() {
        let (_dir, path) = init_test_repo();
        assert!(is_repo(&path));
        assert!(!is_repo(&std::env::temp_dir()));
    }

    #[test]
    fn worktree_add_and_remove() {
        let (_dir, path) = init_test_repo();
        let wt_path = path.join(".pragma/worktrees/test-wt");
        fs::create_dir_all(wt_path.parent().unwrap()).unwrap();

        worktree_add(&path, "feature/test", &wt_path).unwrap();
        assert!(wt_path.join(".git").exists());

        worktree_remove(&path, &wt_path).unwrap();
        assert!(!wt_path.exists());
    }

    #[test]
    fn ensure_pragma_excluded_adds_entry() {
        let dir = TempDir::new().unwrap();
        let path = dir.path();
        run_git(path, &["init"]).unwrap();
        run_git(path, &["config", "user.email", "test@test.com"]).unwrap();
        run_git(path, &["config", "user.name", "Test"]).unwrap();

        ensure_pragma_excluded(path).unwrap();
        let content = fs::read_to_string(path.join(".git/info/exclude")).unwrap();
        assert!(content.contains(".pragma/"));
    }
}
