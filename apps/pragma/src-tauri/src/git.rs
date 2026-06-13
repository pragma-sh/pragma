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

    use super::{current_branch, ensure_pragma_excluded, ensure_repo};

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
}
