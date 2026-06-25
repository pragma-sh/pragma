use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use pragma_constants::{ChangeStatus, ChangedFile, DiffSide, FileDiff, Worktree, WorktreeChanges};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

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
///
/// If git no longer recognizes the path as a worktree (the directory was
/// already removed, the admin files were pruned/corrupted, or the `.git` file
/// is missing), `git worktree remove` fails with "is not a working tree". The
/// worktree is effectively unmanaged at that point, so we prune stale admin
/// entries, delete any orphaned directory, and return `Ok` — without this, a
/// worktree whose admin state drifted would be stuck in the sidebar forever:
/// the delete command would error out before reaching the DB-row deletion.
pub fn remove_worktree(repo_path: &Path, worktree_path: &Path, force: bool) -> AppResult<()> {
    // If the worktree directory is already gone, `git worktree remove` would
    // fail with "is not a working tree" — but the user's intent is already
    // satisfied on disk. Prune stale admin entries and return.
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
    // "is not a working tree" / "not a git worktree" means git no longer
    // manages this path as a worktree. Prune the stale admin entry, remove the
    // orphaned directory, and succeed so the caller can delete the DB row.
    // Other failures (e.g. dirty worktree without `--force`) are propagated.
    if stderr.contains("not a working tree") || stderr.contains("not a git worktree") {
        prune_worktrees(repo_path)?;
        if worktree_path.exists() {
            // Best-effort: the directory is no longer git-managed but still on
            // disk. PTY sessions were already killed by the caller, so the
            // directory should be removable. If it isn't (permissions, open
            // handles), log and continue so the DB row is still removed and
            // the worktree disappears from the sidebar.
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

/// Prunes stale worktree administrative entries (`git worktree prune`). Used by
/// [`remove_worktree`] to clean up after a worktree whose directory was already
/// removed or whose admin state drifted.
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

/// Lists a worktree's changes split into three axes: **committed** (everything
/// the worktree has committed since it forked from its base branch), **staged**
/// (changes added to the index, HEAD → index) and **unstaged** (working-tree
/// changes not staged, plus untracked files).
#[tauri::command]
pub fn worktree_changes(db: State<'_, Db>, worktree_id: String) -> AppResult<WorktreeChanges> {
    worktree_changes_impl(&db, &worktree_id)
}

fn worktree_changes_impl(db: &Db, worktree_id: &str) -> AppResult<WorktreeChanges> {
    let worktree = db.worktree(worktree_id)?;
    let root = PathBuf::from(&worktree.path);

    let committed = match base_merge_base(db, &worktree)? {
        Some(merge_base) => {
            let args = [
                "diff",
                "--name-status",
                "-z",
                "--find-renames",
                &merge_base,
                "HEAD",
            ];
            let name_status = run_git(&root, &args)?;
            let mut changes = parse_name_status(&name_status, DiffSide::Committed);
            let numstat = run_git(&root, &numstat_args(&args))?;
            attach_numstat(&mut changes, &parse_numstat(&numstat));
            changes
        }
        None => Vec::new(),
    };

    let staged_args = ["diff", "--name-status", "-z", "--find-renames", "--cached"];
    let staged_name_status = run_git(&root, &staged_args)?;
    let mut staged = parse_name_status(&staged_name_status, DiffSide::Staged);
    let staged_numstat = run_git(&root, &numstat_args(&staged_args))?;
    attach_numstat(&mut staged, &parse_numstat(&staged_numstat));

    let unstaged_args = ["diff", "--name-status", "-z", "--find-renames"];
    let unstaged_name_status = run_git(&root, &unstaged_args)?;
    let mut unstaged = parse_name_status(&unstaged_name_status, DiffSide::Unstaged);
    let unstaged_numstat = run_git(&root, &numstat_args(&unstaged_args))?;
    attach_numstat(&mut unstaged, &parse_numstat(&unstaged_numstat));

    let untracked = run_git(&root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    for path in untracked.split(|byte| *byte == 0).filter(|s| !s.is_empty()) {
        let path = String::from_utf8_lossy(path).into_owned();
        let additions = untracked_line_count(&root, &path);
        unstaged.push(ChangedFile {
            path,
            old_path: None,
            status: ChangeStatus::Untracked,
            side: DiffSide::Unstaged,
            additions,
            deletions: Some(0),
        });
    }

    Ok(WorktreeChanges {
        committed,
        staged,
        unstaged,
    })
}

/// Reports, for each requested worktree, whether it is fully **merged & clean** —
/// i.e. all three `worktree_changes` axes would be empty (its HEAD is already
/// contained by the parent branch, and it has nothing staged, unstaged, or
/// untracked).
///
/// This is the cheap equivalent of calling `worktree_changes` purely to test
/// `committed/staged/unstaged.is_empty()`. The sidebar polls merge status for
/// *every* child worktree on an interval; doing it via `worktree_changes` ran
/// 7+ git subprocesses per worktree and shipped full file lists across IPC just
/// to read three lengths, which flooded the UI thread (visible as terminal lag
/// and slow project switches when a project has many worktrees). This runs at
/// most two cheap git commands per worktree and returns a compact boolean map in
/// a single IPC call. A worktree that errors is reported as not-merged so a
/// single bad checkout never fails the whole batch.
#[tauri::command]
pub fn worktrees_merged_status(
    db: State<'_, Db>,
    worktree_ids: Vec<String>,
) -> HashMap<String, bool> {
    worktree_ids
        .into_iter()
        .map(|id| {
            let merged = worktree_is_merged(&db, &id).unwrap_or(false);
            (id, merged)
        })
        .collect()
}

/// True when a worktree's work has been merged into its parent branch and its
/// working tree is clean — i.e. the sidebar can offer the delete action without
/// losing uncommitted work. See [`worktrees_merged_status`].
///
/// A freshly-created child (no commits, clean tree) is **not** merged even
/// though `HEAD` is trivially an ancestor of the parent branch: there is no
/// work to merge yet, so showing a merge glyph would be misleading. We detect
/// "no commits" via the branch reflog — a branch with only its creation entry
/// has never had a commit made on it. The reflog is the only signal that
/// survives a fast-forward merge, which collapses `HEAD` and the parent branch
/// onto the same SHA and would otherwise be indistinguishable from a fresh
/// child by SHA comparison alone.
fn worktree_is_merged(db: &Db, worktree_id: &str) -> AppResult<bool> {
    let worktree = db.worktree(worktree_id)?;
    let root = PathBuf::from(&worktree.path);
    // Any staged, unstaged, or untracked change makes it not-merged (strict
    // porcelain check, untracked included).
    if worktree_is_dirty(&root) {
        return Ok(false);
    }
    // Parentless/main worktrees have no parent to merge into, and the sidebar
    // never offers a delete action for them — report not-merged so the icon
    // stays a branch glyph instead of a misleading merge glyph.
    let Some(parent_id) = worktree.parent_id.as_deref() else {
        return Ok(false);
    };
    // A branch with no commits beyond its creation is fresh, not merged.
    if !branch_has_commits(&root, &worktree.branch)? {
        return Ok(false);
    }
    let parent = db.worktree(parent_id)?;
    let output = Command::new("git")
        .args([
            "-C",
            path_string(&root).as_str(),
            "merge-base",
            "--is-ancestor",
            "HEAD",
            &parent.branch,
        ])
        .output()?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(AppError::Git(command_output(output.stdout, output.stderr))),
    }
}

/// True when the branch has at least one commit beyond its creation entry.
/// Uses the branch reflog: a branch with only its "Created from …" entry was
/// never committed to. Falls back to `true` when the reflog is unavailable
/// (pruned, disabled, etc.) so a legitimate merged indicator isn't suppressed
/// for a worktree whose history we can't inspect.
fn branch_has_commits(root: &Path, branch: &str) -> AppResult<bool> {
    let output = Command::new("git")
        .args([
            "-C",
            path_string(root).as_str(),
            "reflog",
            "show",
            "--format=%H",
            branch,
        ])
        .output()?;
    if !output.status.success() {
        return Ok(true);
    }
    let count = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .count();
    Ok(count > 1)
}

/// Loads the old/new text for a single changed file on the given diff side.
/// Binary files report `binary: true` with empty texts (bytes never cross IPC).
#[tauri::command]
pub fn file_diff(
    db: State<'_, Db>,
    worktree_id: String,
    path: String,
    side: DiffSide,
    old_path: Option<String>,
) -> AppResult<FileDiff> {
    file_diff_impl(&db, &worktree_id, path, side, old_path)
}

fn file_diff_impl(
    db: &Db,
    worktree_id: &str,
    path: String,
    side: DiffSide,
    old_path: Option<String>,
) -> AppResult<FileDiff> {
    let worktree = db.worktree(worktree_id)?;
    let root = PathBuf::from(&worktree.path);

    match side {
        DiffSide::Committed => {
            let Some(merge_base) = base_merge_base(db, &worktree)? else {
                return Ok(empty_diff(path));
            };
            if diff_is_binary(&root, &[&merge_base, "HEAD"], &path) {
                return Ok(binary_diff(path));
            }
            let old_ref_path = old_path.as_deref().unwrap_or(&path);
            let old_text =
                git_show(&root, &format!("{merge_base}:{old_ref_path}")).unwrap_or_default();
            let new_text = git_show(&root, &format!("HEAD:{path}")).unwrap_or_default();
            Ok(FileDiff {
                path,
                old_text,
                new_text,
                binary: false,
            })
        }
        DiffSide::Staged => {
            if diff_is_binary(&root, &["--cached"], &path) {
                return Ok(binary_diff(path));
            }
            // Old side is the committed (HEAD) version (empty for a newly-added
            // file); new side is the staged/index version (empty if staged for
            // deletion).
            let old_ref_path = old_path.as_deref().unwrap_or(&path);
            let old_text = git_show(&root, &format!("HEAD:{old_ref_path}")).unwrap_or_default();
            let new_text = git_show(&root, &format!(":{path}")).unwrap_or_default();
            Ok(FileDiff {
                path,
                old_text,
                new_text,
                binary: false,
            })
        }
        DiffSide::Unstaged => {
            if diff_is_binary(&root, &[], &path) {
                return Ok(binary_diff(path));
            }
            // Old side is the staged/index version (empty for an untracked file);
            // new side is the working-tree file (empty if deleted on disk).
            let old_text = git_show(&root, &format!(":{path}")).unwrap_or_default();
            let new_text = std::fs::read(root.join(&path))
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default();
            Ok(FileDiff {
                path,
                old_text,
                new_text,
                binary: false,
            })
        }
        DiffSide::Worktree => {
            // The unified review diff every Changes-sidebar click opens: compare
            // the file's current on-disk content against what used to be on the
            // worktree at its fork point (the merge-base with the parent branch),
            // folding committed + staged + unstaged changes into one diff. A
            // parentless/main worktree has no fork point, so we fall back to HEAD
            // (its last commit is "what used to be").
            let base_ref = base_merge_base(db, &worktree)?.unwrap_or_else(|| "HEAD".to_string());
            if diff_is_binary(&root, &[&base_ref], &path) {
                return Ok(binary_diff(path));
            }
            // Old side is the base version (empty for a file added since the fork
            // point); new side is the working-tree file (empty if deleted on disk).
            let old_ref_path = old_path.as_deref().unwrap_or(&path);
            let old_text =
                git_show(&root, &format!("{base_ref}:{old_ref_path}")).unwrap_or_default();
            let new_text = std::fs::read(root.join(&path))
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default();
            Ok(FileDiff {
                path,
                old_text,
                new_text,
                binary: false,
            })
        }
    }
}

/// Loads the old/new text for a single file in a **PR-style** diff: the
/// three-dot range `base...HEAD` (i.e. the merge-base of `base` and `HEAD`, to
/// `HEAD`). Feeds the GitHub review tab's `CodeMirror` merge view real
/// before/after text produced locally rather than from API patches. Binary files
/// report `binary: true` with empty texts. `base` is any ref (e.g. `origin/main`).
pub fn pr_file_diff(root: &Path, base: &str, path: &str, old_path: Option<&str>) -> FileDiff {
    let merge_base = merge_base(root, base, "HEAD").unwrap_or_else(|| base.to_string());
    if diff_is_binary(root, &[&merge_base, "HEAD"], path) {
        return binary_diff(path.to_string());
    }
    let old_ref_path = old_path.unwrap_or(path);
    let old_text = git_show(root, &format!("{merge_base}:{old_ref_path}")).unwrap_or_default();
    let new_text = git_show(root, &format!("HEAD:{path}")).unwrap_or_default();
    FileDiff {
        path: path.to_string(),
        old_text,
        new_text,
        binary: false,
    }
}

/// Resolves the merge-base (common ancestor) of two refs, or `None` when git
/// can't (unrelated histories, a missing ref).
fn merge_base(root: &Path, a: &str, b: &str) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path_string(root))
        .args(["merge-base", a, b])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!sha.is_empty()).then_some(sha)
}

/// Discards a single **unstaged** change, reverting the working-tree file to
/// match the index. Tracked modifications/deletions are restored with
/// `git restore`; an untracked file is deleted; a working-tree rename restores
/// the original path and removes the new one. The path is worktree-relative and
/// validated against escaping the worktree. **Destructive and irreversible.**
#[tauri::command]
pub fn discard_unstaged_file(
    db: State<'_, Db>,
    worktree_id: String,
    path: String,
    status: ChangeStatus,
    old_path: Option<String>,
) -> AppResult<()> {
    discard_unstaged_file_impl(&db, &worktree_id, &path, status, old_path.as_deref())
}

fn discard_unstaged_file_impl(
    db: &Db,
    worktree_id: &str,
    path: &str,
    status: ChangeStatus,
    old_path: Option<&str>,
) -> AppResult<()> {
    let worktree = db.worktree(worktree_id)?;
    let root = PathBuf::from(&worktree.path);
    match status {
        ChangeStatus::Untracked => remove_untracked(&root, path)?,
        ChangeStatus::Renamed => {
            // A working-tree rename: bring back the original, drop the new file.
            if let Some(old) = old_path {
                git_restore(&root, old)?;
            }
            remove_untracked(&root, path)?;
        }
        ChangeStatus::Added | ChangeStatus::Modified | ChangeStatus::Deleted => {
            git_restore(&root, path)?;
        }
    }
    Ok(())
}

/// Discards **every** unstaged change in the worktree: restores all tracked
/// files from the index and removes untracked files and directories (gitignored
/// files are left untouched). **Destructive and irreversible.**
#[tauri::command]
pub fn discard_all_unstaged(db: State<'_, Db>, worktree_id: String) -> AppResult<()> {
    discard_all_unstaged_impl(&db, &worktree_id)
}

fn discard_all_unstaged_impl(db: &Db, worktree_id: &str) -> AppResult<()> {
    let worktree = db.worktree(worktree_id)?;
    let root = PathBuf::from(&worktree.path);
    // Restore tracked modifications/deletions from the index…
    run_git(&root, &["restore", "--", "."])?;
    // …then sweep untracked files and directories (gitignored files are kept).
    run_git(&root, &["clean", "-fd"])?;
    Ok(())
}

/// Stages a single worktree-relative change into the index (`git add`). Handles
/// new, modified, and deleted files alike. The path is validated against
/// escaping the worktree.
#[tauri::command]
pub fn stage_file(db: State<'_, Db>, worktree_id: String, path: String) -> AppResult<()> {
    stage_file_impl(&db, &worktree_id, &path)
}

fn stage_file_impl(db: &Db, worktree_id: &str, path: &str) -> AppResult<()> {
    let worktree = db.worktree(worktree_id)?;
    let root = PathBuf::from(&worktree.path);
    crate::fs::resolve_in_worktree(&root, path)?;
    run_git(&root, &["add", "--", path])?;
    Ok(())
}

/// Stages **every** change in the worktree into the index (`git add -A`),
/// including new, modified, deleted, and untracked files.
#[tauri::command]
pub fn stage_all(db: State<'_, Db>, worktree_id: String) -> AppResult<()> {
    stage_all_impl(&db, &worktree_id)
}

fn stage_all_impl(db: &Db, worktree_id: &str) -> AppResult<()> {
    let worktree = db.worktree(worktree_id)?;
    let root = PathBuf::from(&worktree.path);
    run_git(&root, &["add", "-A"])?;
    Ok(())
}

/// Unstages a single worktree-relative change from the index, leaving the
/// working-tree file untouched (`git restore --staged`). For a staged rename the
/// original path is unstaged as well. The path is validated against escaping the
/// worktree.
#[tauri::command]
pub fn unstage_file(
    db: State<'_, Db>,
    worktree_id: String,
    path: String,
    old_path: Option<String>,
) -> AppResult<()> {
    unstage_file_impl(&db, &worktree_id, &path, old_path.as_deref())
}

fn unstage_file_impl(
    db: &Db,
    worktree_id: &str,
    path: &str,
    old_path: Option<&str>,
) -> AppResult<()> {
    let worktree = db.worktree(worktree_id)?;
    let root = PathBuf::from(&worktree.path);
    git_restore_staged(&root, path)?;
    if let Some(old) = old_path {
        git_restore_staged(&root, old)?;
    }
    Ok(())
}

/// Unstages **every** staged change in the worktree, resetting the index to
/// `HEAD` while leaving the working tree untouched (`git reset`).
#[tauri::command]
pub fn unstage_all(db: State<'_, Db>, worktree_id: String) -> AppResult<()> {
    unstage_all_impl(&db, &worktree_id)
}

fn unstage_all_impl(db: &Db, worktree_id: &str) -> AppResult<()> {
    let worktree = db.worktree(worktree_id)?;
    let root = PathBuf::from(&worktree.path);
    run_git(&root, &["reset", "-q", "HEAD", "--", "."])?;
    Ok(())
}

/// Creates a commit from the worktree's staged changes (`git commit -m <msg>`).
/// The message is trimmed; empty messages are rejected up front so the caller
/// gets a clear `InvalidInput` rather than git's "Aborting commit due to empty
/// commit message" stderr.
#[tauri::command]
pub fn commit_staged(db: State<'_, Db>, worktree_id: String, message: String) -> AppResult<()> {
    commit_staged_impl(&db, &worktree_id, &message)
}

fn commit_staged_impl(db: &Db, worktree_id: &str, message: &str) -> AppResult<()> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "commit message is empty".to_string(),
        ));
    }
    let worktree = db.worktree(worktree_id)?;
    let root = PathBuf::from(&worktree.path);
    run_git(&root, &["commit", "-m", trimmed])?;
    Ok(())
}

/// Merges a child worktree's branch into its recorded parent worktree. The
/// parent must be clean before starting so any conflicts belong only to this
/// merge attempt and can be resolved or aborted in the parent worktree.
#[tauri::command]
pub fn merge_worktree_to_parent(
    db: State<'_, Db>,
    locks: State<'_, GitLocks>,
    worktree_id: String,
) -> AppResult<()> {
    let worktree = db.worktree(&worktree_id)?;
    let lock = locks.lock_for(&worktree.project_id)?;
    let _guard = lock.lock()?;
    merge_worktree_to_parent_impl(&db, &worktree_id)
}

fn merge_worktree_to_parent_impl(db: &Db, worktree_id: &str) -> AppResult<()> {
    let worktree = db.worktree(worktree_id)?;
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
    let parent_root = PathBuf::from(&parent.path);
    let child_root = PathBuf::from(&worktree.path);

    if worktree_is_dirty(&parent_root) {
        return Err(AppError::InvalidInput(format!(
            "parent worktree {} has uncommitted changes; commit, stash, or discard them before merging",
            parent.branch
        )));
    }
    if worktree_is_dirty(&child_root) {
        return Err(AppError::InvalidInput(
            "commit or discard this worktree's staged, unstaged, and untracked changes before merging"
                .to_string(),
        ));
    }

    let output = Command::new("git")
        .args([
            "-C",
            path_string(&parent_root).as_str(),
            "merge",
            "--no-edit",
            &worktree.branch,
        ])
        .output()?;
    if output.status.success() {
        return Ok(());
    }
    if has_unmerged_paths(&parent_root)? {
        let parent_path = path_string(&parent_root);
        return Err(AppError::Git(format!(
            "Merge conflicts detected in {}. Resolve them in an IDE in {} or run `git -C \"{}\" status`, fix the conflicts, then run `git -C \"{}\" merge --continue`. To cancel, run `git -C \"{}\" merge --abort`.",
            parent.branch, parent_path, parent_path, parent_path, parent_path
        )));
    }
    Err(AppError::Git(command_output(output.stdout, output.stderr)))
}

/// Unstages a single worktree-relative pathspec (index → HEAD) without touching
/// the working tree, after asserting it stays inside the worktree.
fn git_restore_staged(root: &Path, path: &str) -> AppResult<()> {
    crate::fs::resolve_in_worktree(root, path)?;
    run_git(root, &["restore", "--staged", "--", path])?;
    Ok(())
}

/// Restores a single worktree-relative pathspec from the index, after asserting
/// it stays inside the worktree.
fn git_restore(root: &Path, path: &str) -> AppResult<()> {
    crate::fs::resolve_in_worktree(root, path)?;
    run_git(root, &["restore", "--", path])?;
    Ok(())
}

/// Deletes an untracked worktree-relative file or directory, refusing any path
/// that escapes the worktree.
fn remove_untracked(root: &Path, path: &str) -> AppResult<()> {
    let target = crate::fs::resolve_in_worktree(root, path)?;
    if target.is_dir() {
        std::fs::remove_dir_all(&target)?;
    } else if target.exists() {
        std::fs::remove_file(&target)?;
    }
    Ok(())
}

fn has_unmerged_paths(root: &Path) -> AppResult<bool> {
    let output = Command::new("git")
        .args([
            "-C",
            path_string(root).as_str(),
            "diff",
            "--name-only",
            "--diff-filter=U",
        ])
        .output()?;
    if output.status.success() {
        Ok(!output.stdout.is_empty())
    } else {
        Err(AppError::Git(stderr(output.stderr)))
    }
}

/// Resolves the diff base for a worktree's committed changes: the merge-base
/// (fork point) of `HEAD` and the parent worktree's branch. Returns `None` for a
/// parentless/main worktree, a missing HEAD, or unrelated histories — in which
/// case the committed list is simply empty.
fn base_merge_base(db: &Db, worktree: &Worktree) -> AppResult<Option<String>> {
    let Some(parent_id) = worktree.parent_id.as_deref() else {
        return Ok(None);
    };
    let parent = db.worktree(parent_id)?;
    let root = PathBuf::from(&worktree.path);
    let output = Command::new("git")
        .arg("-C")
        .arg(path_string(&root))
        .args(["merge-base", "HEAD", &parent.branch])
        .output()?;
    if !output.status.success() {
        return Ok(None);
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!sha.is_empty()).then_some(sha))
}

/// Parses `git diff --name-status -z` output into changed-file records. The `-z`
/// stream is NUL-separated tokens; a rename/copy record carries two paths. The
/// `additions` / `deletions` fields are left as `None` and filled in by
/// `attach_numstat` after a parallel `git diff --numstat -z` call.
fn parse_name_status(stdout: &[u8], side: DiffSide) -> Vec<ChangedFile> {
    let tokens: Vec<&[u8]> = stdout.split(|byte| *byte == 0).collect();
    let mut changes = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let status_field = tokens[index];
        index += 1;
        let Some(code) = status_field.first().copied() else {
            continue;
        };
        if code == b'R' || code == b'C' {
            let (Some(old), Some(new)) = (tokens.get(index), tokens.get(index + 1)) else {
                break;
            };
            index += 2;
            changes.push(ChangedFile {
                path: String::from_utf8_lossy(new).into_owned(),
                old_path: Some(String::from_utf8_lossy(old).into_owned()),
                status: ChangeStatus::Renamed,
                side,
                additions: None,
                deletions: None,
            });
        } else {
            let Some(path) = tokens.get(index) else {
                break;
            };
            index += 1;
            changes.push(ChangedFile {
                path: String::from_utf8_lossy(path).into_owned(),
                old_path: None,
                status: status_from_code(code),
                side,
                additions: None,
                deletions: None,
            });
        }
    }
    changes
}

/// Returns the `--name-status` arguments but with `--name-status` swapped for
/// `--numstat`. The rev arguments are kept verbatim, so the numstat call covers
/// exactly the same file set as the matching name-status call.
fn numstat_args<'a>(name_status_args: &[&'a str]) -> Vec<&'a str> {
    name_status_args
        .iter()
        .map(|&arg| {
            if arg == "--name-status" {
                "--numstat"
            } else {
                arg
            }
        })
        .collect()
}

/// Parses `git diff --numstat -z` output into `(path, additions, deletions)`
/// triples. For renames/copies the numstat columns are emitted against the
/// **old** path followed by a NUL and then the new path; we record the counts
/// under both keys so a later lookup by `path` (which `parse_name_status`
/// always sets to the new path) succeeds. A `-` in either column marks a
/// binary file; we surface that as `None` so the UI can render a dash.
fn parse_numstat(stdout: &[u8]) -> HashMap<String, (Option<u64>, Option<u64>)> {
    let mut out = HashMap::new();
    let tokens: Vec<&[u8]> = stdout.split(|byte| *byte == 0).collect();
    let mut index = 0;
    while index < tokens.len() {
        let line = tokens[index];
        index += 1;
        if line.is_empty() {
            continue;
        }
        // Format: "<added>\t<removed>\t<path>" (with `-` for binary columns).
        let mut parts = line.splitn(3, |byte| *byte == b'\t');
        let Some(added) = parts.next() else { continue };
        let Some(removed) = parts.next() else {
            continue;
        };
        let Some(rest) = parts.next() else { continue };
        let additions = if added == b"-" { None } else { atoi(added) };
        let deletions = if removed == b"-" { None } else { atoi(removed) };

        // Renames/copies carry a second NUL-terminated path (the new name) with
        // the same counts; record under both keys.
        let old_key = String::from_utf8_lossy(rest).into_owned();
        out.insert(old_key.clone(), (additions, deletions));
        if let Some(next) = tokens.get(index) {
            if !next.is_empty() && !next.contains(&b'\t') {
                index += 1;
                let new_key = String::from_utf8_lossy(next).into_owned();
                out.insert(new_key, (additions, deletions));
            }
        }
    }
    out
}

/// Fills in `additions` / `deletions` on each record from the numstat map. A
/// record with no numstat entry (e.g. a binary file already filtered out, or
/// an untracked file) keeps its `None` values. Renames are looked up by the
/// new path, matching the `path` field written by `parse_name_status`.
fn attach_numstat(
    changes: &mut [ChangedFile],
    numstat: &HashMap<String, (Option<u64>, Option<u64>)>,
) {
    for change in changes {
        if let Some((additions, deletions)) = numstat.get(&change.path) {
            change.additions = *additions;
            change.deletions = *deletions;
        }
    }
}

/// Counts the newlines in an untracked file, returning `None` for anything we
/// can't read or that isn't valid UTF-8. Newline count is a good-enough
/// approximation for the additions a brand-new file contributes; an exact
/// line count would require reading the whole file twice.
fn untracked_line_count(root: &Path, path: &str) -> Option<u64> {
    crate::fs::resolve_in_worktree(root, path).ok()?;
    let bytes = std::fs::read(root.join(path)).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    Some(text.bytes().filter(|byte| *byte == b'\n').count() as u64)
}

/// Parses a non-negative integer from raw bytes. Returns `None` for empty or
/// non-numeric input — keeps a malformed numstat line from panicking the diff
/// listing.
fn atoi(bytes: &[u8]) -> Option<u64> {
    if bytes.is_empty() {
        return None;
    }
    let mut value: u64 = 0;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value.checked_mul(10)?.checked_add(u64::from(byte - b'0'))?;
    }
    Some(value)
}

fn status_from_code(code: u8) -> ChangeStatus {
    match code {
        b'A' => ChangeStatus::Added,
        b'D' => ChangeStatus::Deleted,
        _ => ChangeStatus::Modified,
    }
}

/// True when `git diff --numstat` reports the file as binary (`-`/`-` columns).
/// `revs` are the optional diff endpoints (empty = working tree vs index).
fn diff_is_binary(root: &Path, revs: &[&str], path: &str) -> bool {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(path_string(root))
        .args(["diff", "--numstat"]);
    for rev in revs {
        command.arg(rev);
    }
    command.arg("--").arg(path);
    match command.output() {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.starts_with("-\t-")),
        _ => false,
    }
}

/// Runs `git show <spec>` in a worktree, returning the stdout text on success.
fn git_show(root: &Path, spec: &str) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path_string(root))
        .args(["show", spec])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Runs an arbitrary `git -C <root> …` command, returning stdout or a `Git` error.
fn run_git(root: &Path, args: &[&str]) -> AppResult<Vec<u8>> {
    let output = crate::process_env::command("git")
        .arg("-C")
        .arg(path_string(root))
        .args(args)
        .output()?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(AppError::Git(stderr(output.stderr)))
    }
}

fn empty_diff(path: String) -> FileDiff {
    FileDiff {
        path,
        old_text: String::new(),
        new_text: String::new(),
        binary: false,
    }
}

fn binary_diff(path: String) -> FileDiff {
    FileDiff {
        path,
        old_text: String::new(),
        new_text: String::new(),
        binary: true,
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn stderr(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn command_output(stdout: Vec<u8>, stderr_bytes: Vec<u8>) -> String {
    let stderr_text = stderr(stderr_bytes);
    if !stderr_text.is_empty() {
        return stderr_text;
    }
    String::from_utf8_lossy(&stdout).trim().to_string()
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command;

    use pragma_constants::{ChangeStatus, DiffSide};
    use tempfile::tempdir;

    use super::{
        branch_has_commits, commit_staged_impl, current_branch, discard_all_unstaged_impl,
        discard_unstaged_file_impl, ensure_pragma_excluded, ensure_repo, file_diff_impl,
        merge_worktree_to_parent_impl, remove_worktree, stage_all_impl, stage_file_impl,
        unstage_all_impl, unstage_file_impl, worktree_changes_impl, worktree_is_dirty,
        worktree_is_merged, PRAGMA_WORKTREES_EXCLUDE,
    };
    use crate::db::Db;

    fn run(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git command");
        assert!(output.status.success(), "git {args:?} failed");
    }

    fn commit_all(dir: &Path, message: &str) {
        run(dir, &["add", "-A"]);
        run(
            dir,
            &[
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "commit",
                "-m",
                message,
            ],
        );
    }

    /// Builds a project with a `main` worktree plus a `feature` child worktree
    /// (forked from `main`) and returns the `Db`, the child worktree id, the
    /// child worktree path, and the main worktree path.
    fn project_with_child() -> (Db, String, std::path::PathBuf, std::path::PathBuf) {
        let main = tempdir().expect("tempdir");
        let main_path = main.path().to_path_buf();
        run(&main_path, &["init", "-b", "main"]);
        // Persist an identity on the repo so the production commit/merge paths
        // (which rely on ambient git config, not the `-c` flags `commit_all`
        // passes) have an author on a clean CI runner with no global identity.
        // Linked worktrees share this common config.
        run(&main_path, &["config", "user.email", "test@example.com"]);
        run(&main_path, &["config", "user.name", "Test"]);
        std::fs::write(main_path.join("base.txt"), "base\n").expect("write base");
        commit_all(&main_path, "base commit");

        // Place the child worktree outside the main working tree so it can't
        // contaminate the main repo's status.
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

        // Keep the temp dirs alive for the duration of the test by leaking the
        // guards — the OS reclaims them when the process exits.
        std::mem::forget(main);
        std::mem::forget(child_root);

        let db = Db::in_memory().expect("db");
        let project = db
            .insert_project_with_main_worktree(
                "repo".to_string(),
                main_path.to_string_lossy().into_owned(),
                "main".to_string(),
            )
            .expect("project");
        let parent = db
            .list_worktrees(&project.id)
            .expect("worktrees")
            .into_iter()
            .find(|w| w.is_main)
            .expect("main worktree");
        let child = db
            .insert_worktree(
                "wt-child",
                &project.id,
                &parent.id,
                "feature",
                None,
                child_path.to_string_lossy().as_ref(),
            )
            .expect("child worktree");
        (db, child.id, child_path, main_path)
    }

    #[test]
    fn committed_list_uses_fork_point_not_parent_tip() {
        let (db, child_id, child_path, main_path) = project_with_child();
        // Commit something on the child (this is the committed delta vs base).
        std::fs::write(child_path.join("feature.txt"), "feature\n").expect("write feature");
        commit_all(&child_path, "feature commit");
        // Advance the parent (main) tip *after* the fork — its new file must NOT
        // appear in the child's committed list, which diffs the fork point.
        std::fs::write(main_path.join("main-only.txt"), "main\n").expect("write main-only");
        commit_all(&main_path, "main moves on");

        let changes = worktree_changes_impl(&db, &child_id).expect("changes");
        assert!(
            changes
                .committed
                .iter()
                .any(|c| c.path == "feature.txt" && c.status == ChangeStatus::Added),
            "committed should list the file added since the fork point"
        );
        // base.txt existed at the fork point and is unchanged → not listed.
        assert!(!changes.committed.iter().any(|c| c.path == "base.txt"));
        // main-only.txt landed on the parent after the fork → must not be listed.
        assert!(!changes.committed.iter().any(|c| c.path == "main-only.txt"));
    }

    #[test]
    fn committed_diff_counts_match_fork_point_delta() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        // Two-line addition on the child (since the fork point).
        std::fs::write(child_path.join("feature.txt"), "alpha\nbeta\n").expect("write feature");
        commit_all(&child_path, "feature commit");

        let changes = worktree_changes_impl(&db, &child_id).expect("changes");
        let feature = changes
            .committed
            .iter()
            .find(|c| c.path == "feature.txt")
            .expect("feature.txt committed");
        assert_eq!(feature.additions, Some(2));
        assert_eq!(feature.deletions, Some(0));
    }

    #[test]
    fn unstaged_list_includes_working_changes_and_untracked() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        // Modify a tracked file without staging, and add an untracked file.
        std::fs::write(child_path.join("base.txt"), "changed\n").expect("modify base");
        std::fs::write(child_path.join("new.txt"), "new\n").expect("write new");

        let changes = worktree_changes_impl(&db, &child_id).expect("changes");
        assert!(changes
            .unstaged
            .iter()
            .any(|c| c.path == "base.txt" && c.status == ChangeStatus::Modified));
        assert!(changes
            .unstaged
            .iter()
            .any(|c| c.path == "new.txt" && c.status == ChangeStatus::Untracked));
    }

    #[test]
    fn diff_counts_report_additions_and_deletions_per_axis() {
        let (db, child_id, child_path, _main_path) = project_with_child();

        // Tracked: 2 new lines, 1 deleted line in the working tree (unstaged).
        // base.txt was committed with "base\n" (1 line). Replace with a 2-line
        // version so the diff is +2/-1.
        std::fs::write(child_path.join("base.txt"), "first\nsecond\n").expect("rewrite base");

        // Tracked + staged: 1 new line, 0 deleted.
        std::fs::write(child_path.join("feature.txt"), "only line\n").expect("write feature");
        run(&child_path, &["add", "feature.txt"]);

        // Untracked: counts as additions equal to the file's newline count, zero
        // deletions (a brand-new file has nothing to remove).
        std::fs::write(child_path.join("scratch.txt"), "a\nb\nc\nd\n").expect("write scratch");

        let changes = worktree_changes_impl(&db, &child_id).expect("changes");

        let unstaged = changes
            .unstaged
            .iter()
            .find(|c| c.path == "base.txt")
            .expect("base.txt unstaged");
        assert_eq!(unstaged.additions, Some(2));
        assert_eq!(unstaged.deletions, Some(1));

        let staged = changes
            .staged
            .iter()
            .find(|c| c.path == "feature.txt")
            .expect("feature.txt staged");
        assert_eq!(staged.additions, Some(1));
        assert_eq!(staged.deletions, Some(0));

        let untracked = changes
            .unstaged
            .iter()
            .find(|c| c.path == "scratch.txt" && c.status == ChangeStatus::Untracked)
            .expect("scratch.txt untracked");
        assert_eq!(untracked.additions, Some(4));
        assert_eq!(untracked.deletions, Some(0));
    }

    #[test]
    fn parentless_worktree_has_empty_committed_list() {
        let (db, _child_id, _child_path, _main_path) = project_with_child();
        let main = db
            .list_worktrees(&db.list_projects().expect("projects")[0].id)
            .expect("worktrees")
            .into_iter()
            .find(|w| w.is_main)
            .expect("main worktree");
        let changes = worktree_changes_impl(&db, &main.id).expect("changes");
        assert!(changes.committed.is_empty());
    }

    #[test]
    fn merged_status_tracks_commits_and_working_tree() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        // Fresh child: forked from main, no commits on the branch, clean tree
        // → NOT merged. There's no work to merge yet, so showing a merge glyph
        // would be misleading (the sidebar should show a branch icon instead).
        assert!(!worktree_is_merged(&db, &child_id).expect("merged check"));
        // The branch reflog has only the creation entry.
        assert!(!branch_has_commits(&child_path, "feature").expect("reflog check"));

        // An untracked file dirties the working tree → not merged.
        std::fs::write(child_path.join("scratch.txt"), "x\n").expect("write scratch");
        assert!(!worktree_is_merged(&db, &child_id).expect("merged check"));
        std::fs::remove_file(child_path.join("scratch.txt")).expect("remove scratch");
        // Back to fresh — still not merged (no commits on the branch).
        assert!(!worktree_is_merged(&db, &child_id).expect("merged check"));

        // A commit since the fork point is a committed delta → not merged, but
        // the branch now has commits so the reflog check passes.
        std::fs::write(child_path.join("feature.txt"), "feature\n").expect("write feature");
        commit_all(&child_path, "feature commit");
        assert!(!worktree_is_merged(&db, &child_id).expect("merged check"));
        assert!(branch_has_commits(&child_path, "feature").expect("reflog check"));

        // Once that child HEAD is merged into the parent branch, the clean child
        // has no remaining delta from the sidebar's perspective — the branch
        // still has its commits (reflog), and they're now in the parent.
        merge_worktree_to_parent_impl(&db, &child_id).expect("merge");
        assert!(worktree_is_merged(&db, &child_id).expect("merged check"));
    }

    #[test]
    fn fresh_child_with_no_commits_is_not_merged() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        // A just-created child worktree with a clean tree and no commits must
        // not be reported as merged — this is the regression that caused
        // every fresh worktree to show a merge glyph in the sidebar.
        assert!(!worktree_is_merged(&db, &child_id).expect("merged check"));
        // The branch reflog has only the creation entry → no commits yet.
        assert!(!branch_has_commits(&child_path, "feature").expect("reflog check"));
    }

    #[test]
    fn remove_worktree_succeeds_when_directory_already_gone() {
        let (db, child_id, child_path, main_path) = project_with_child();
        // Simulate the drifted state: the worktree directory was already
        // removed (e.g. by a prior failed delete or manual `rm -rf`), but the
        // DB row and git admin entry are still around. `git worktree remove`
        // would fail with "is not a working tree" — the fix prunes the stale
        // admin entry and returns Ok so the DB row can be deleted.
        std::fs::remove_dir_all(&child_path).expect("remove child dir");
        remove_worktree(&main_path, &child_path, false).expect("remove should succeed");
        db.delete_worktree(&child_id).expect("db delete");
        // The worktree should be gone from the DB.
        let remaining = db
            .list_worktrees(&db.list_projects().expect("projects")[0].id)
            .expect("list");
        assert!(!remaining.iter().any(|w| w.id == child_id));
    }

    #[test]
    fn remove_worktree_succeeds_when_admin_state_drifted() {
        let (_db, _child_id, child_path, main_path) = project_with_child();
        // Simulate a corrupted worktree: the directory still exists but git's
        // admin entry was pruned, so `git worktree remove` fails with "is not a
        // working tree". The fix prunes, removes the orphaned directory, and
        // returns Ok.
        run(&main_path, &["worktree", "prune"]);
        assert!(child_path.exists(), "child dir should still be on disk");
        remove_worktree(&main_path, &child_path, false).expect("remove should succeed");
        assert!(!child_path.exists(), "orphaned dir should be removed");
    }

    #[test]
    fn committed_diff_added_file_has_empty_old_side() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("feature.txt"), "feature\n").expect("write feature");
        commit_all(&child_path, "feature commit");

        let diff = file_diff_impl(
            &db,
            &child_id,
            "feature.txt".to_string(),
            DiffSide::Committed,
            None,
        )
        .expect("diff");
        assert_eq!(diff.old_text, "");
        assert_eq!(diff.new_text, "feature\n");
    }

    #[test]
    fn unstaged_diff_untracked_has_empty_old_side() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("new.txt"), "fresh\n").expect("write new");

        let diff = file_diff_impl(
            &db,
            &child_id,
            "new.txt".to_string(),
            DiffSide::Unstaged,
            None,
        )
        .expect("diff");
        assert_eq!(diff.old_text, "");
        assert_eq!(diff.new_text, "fresh\n");
    }

    #[test]
    fn unstaged_diff_deleted_file_has_empty_new_side() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        std::fs::remove_file(child_path.join("base.txt")).expect("remove base");

        let diff = file_diff_impl(
            &db,
            &child_id,
            "base.txt".to_string(),
            DiffSide::Unstaged,
            None,
        )
        .expect("diff");
        assert_eq!(diff.old_text, "base\n");
        assert_eq!(diff.new_text, "");
    }

    #[test]
    fn worktree_diff_of_existing_file_uses_fork_point_as_old() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        // base.txt was committed with "base\n" at the fork point; edit it.
        std::fs::write(child_path.join("base.txt"), "changed\n").expect("modify base");

        let diff = file_diff_impl(
            &db,
            &child_id,
            "base.txt".to_string(),
            DiffSide::Worktree,
            None,
        )
        .expect("diff");
        assert_eq!(diff.old_text, "base\n");
        assert_eq!(diff.new_text, "changed\n");
    }

    #[test]
    fn worktree_diff_folds_committed_and_unstaged_against_fork_point() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        // Add + commit a new file on the child (a committed delta vs the fork
        // point)…
        std::fs::write(child_path.join("feature.txt"), "committed\n").expect("write feature");
        commit_all(&child_path, "feature commit");
        // …then keep editing it in the working tree without staging.
        std::fs::write(child_path.join("feature.txt"), "committed\nworking\n")
            .expect("edit feature");

        let diff = file_diff_impl(
            &db,
            &child_id,
            "feature.txt".to_string(),
            DiffSide::Worktree,
            None,
        )
        .expect("diff");
        // Old side is the fork point, where feature.txt did not exist.
        assert_eq!(diff.old_text, "");
        // New side is the current working tree — committed + unstaged folded in.
        assert_eq!(diff.new_text, "committed\nworking\n");
    }

    #[test]
    fn discard_unstaged_file_restores_modified_and_removes_untracked() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("base.txt"), "changed\n").expect("modify base");
        std::fs::write(child_path.join("new.txt"), "new\n").expect("write new");

        // A tracked modification is restored from the index…
        discard_unstaged_file_impl(&db, &child_id, "base.txt", ChangeStatus::Modified, None)
            .expect("discard modified");
        assert_eq!(
            std::fs::read_to_string(child_path.join("base.txt")).expect("read base"),
            "base\n"
        );
        // …and an untracked file is deleted from disk.
        discard_unstaged_file_impl(&db, &child_id, "new.txt", ChangeStatus::Untracked, None)
            .expect("discard untracked");
        assert!(!child_path.join("new.txt").exists());

        let changes = worktree_changes_impl(&db, &child_id).expect("changes");
        assert!(changes.unstaged.is_empty());
    }

    #[test]
    fn discard_unstaged_file_restores_deleted_file() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        std::fs::remove_file(child_path.join("base.txt")).expect("remove base");

        discard_unstaged_file_impl(&db, &child_id, "base.txt", ChangeStatus::Deleted, None)
            .expect("discard deleted");
        assert_eq!(
            std::fs::read_to_string(child_path.join("base.txt")).expect("read base"),
            "base\n"
        );
    }

    #[test]
    fn discard_all_unstaged_clears_tracked_and_untracked() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("base.txt"), "changed\n").expect("modify base");
        std::fs::write(child_path.join("new.txt"), "new\n").expect("write new");

        discard_all_unstaged_impl(&db, &child_id).expect("discard all");

        assert_eq!(
            std::fs::read_to_string(child_path.join("base.txt")).expect("read base"),
            "base\n"
        );
        assert!(!child_path.join("new.txt").exists());
        let changes = worktree_changes_impl(&db, &child_id).expect("changes");
        assert!(changes.unstaged.is_empty());
    }

    #[test]
    fn staged_list_separates_index_changes_from_unstaged() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        // Modify a tracked file and stage it; add a second untracked file and
        // leave it unstaged.
        std::fs::write(child_path.join("base.txt"), "staged change\n").expect("modify base");
        std::fs::write(child_path.join("loose.txt"), "loose\n").expect("write loose");
        run(&child_path, &["add", "base.txt"]);

        let changes = worktree_changes_impl(&db, &child_id).expect("changes");
        assert!(changes
            .staged
            .iter()
            .any(|c| c.path == "base.txt" && c.status == ChangeStatus::Modified));
        // The staged file must not also appear as unstaged…
        assert!(!changes.unstaged.iter().any(|c| c.path == "base.txt"));
        // …and the untracked file is still unstaged.
        assert!(changes
            .unstaged
            .iter()
            .any(|c| c.path == "loose.txt" && c.status == ChangeStatus::Untracked));
    }

    #[test]
    fn staged_diff_uses_head_as_old_and_index_as_new() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("base.txt"), "staged\n").expect("modify base");
        run(&child_path, &["add", "base.txt"]);

        let diff = file_diff_impl(
            &db,
            &child_id,
            "base.txt".to_string(),
            DiffSide::Staged,
            None,
        )
        .expect("diff");
        assert_eq!(diff.old_text, "base\n");
        assert_eq!(diff.new_text, "staged\n");
    }

    #[test]
    fn stage_file_moves_change_into_the_index() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("base.txt"), "changed\n").expect("modify base");

        stage_file_impl(&db, &child_id, "base.txt").expect("stage file");

        let changes = worktree_changes_impl(&db, &child_id).expect("changes");
        assert!(changes.staged.iter().any(|c| c.path == "base.txt"));
        assert!(!changes.unstaged.iter().any(|c| c.path == "base.txt"));
    }

    #[test]
    fn stage_all_stages_tracked_and_untracked() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("base.txt"), "changed\n").expect("modify base");
        std::fs::write(child_path.join("new.txt"), "new\n").expect("write new");

        stage_all_impl(&db, &child_id).expect("stage all");

        let changes = worktree_changes_impl(&db, &child_id).expect("changes");
        assert!(changes.staged.iter().any(|c| c.path == "base.txt"));
        assert!(changes.staged.iter().any(|c| c.path == "new.txt"));
        assert!(changes.unstaged.is_empty());
    }

    #[test]
    fn unstage_file_returns_change_to_unstaged() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("base.txt"), "changed\n").expect("modify base");
        run(&child_path, &["add", "base.txt"]);

        unstage_file_impl(&db, &child_id, "base.txt", None).expect("unstage file");

        let changes = worktree_changes_impl(&db, &child_id).expect("changes");
        assert!(changes.staged.is_empty());
        assert!(changes
            .unstaged
            .iter()
            .any(|c| c.path == "base.txt" && c.status == ChangeStatus::Modified));
        // The working-tree edit is preserved — unstaging must not discard it.
        assert_eq!(
            std::fs::read_to_string(child_path.join("base.txt")).expect("read base"),
            "changed\n"
        );
    }

    #[test]
    fn unstage_all_clears_the_index() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("base.txt"), "changed\n").expect("modify base");
        std::fs::write(child_path.join("new.txt"), "new\n").expect("write new");
        run(&child_path, &["add", "-A"]);

        unstage_all_impl(&db, &child_id).expect("unstage all");

        let changes = worktree_changes_impl(&db, &child_id).expect("changes");
        assert!(changes.staged.is_empty());
        assert!(changes.unstaged.iter().any(|c| c.path == "base.txt"));
        assert!(changes.unstaged.iter().any(|c| c.path == "new.txt"));
    }

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
                .filter(|line| line.trim() == PRAGMA_WORKTREES_EXCLUDE)
                .count(),
            1
        );
        assert!(!exclude.lines().any(|line| line.trim() == ".pragma/"));
    }

    #[test]
    fn migrates_broad_pragma_exclude_to_worktrees_only() {
        let dir = tempdir().expect("tempdir");
        Command::new("git")
            .arg("init")
            .current_dir(dir.path())
            .output()
            .expect("git init");
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

    #[test]
    fn commit_staged_creates_a_commit_with_the_given_message() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("feature.txt"), "feature\n").expect("write");
        run(&child_path, &["add", "feature.txt"]);

        commit_staged_impl(&db, &child_id, "add feature").expect("commit");

        // Staged list is empty after the commit…
        let changes = worktree_changes_impl(&db, &child_id).expect("changes");
        assert!(changes.staged.is_empty());
        // …and the new commit shows up in the worktree's log.
        let log = Command::new("git")
            .arg("-C")
            .arg(&child_path)
            .args(["log", "-1", "--pretty=%s"])
            .output()
            .expect("git log");
        assert!(log.status.success());
        let subject = String::from_utf8_lossy(&log.stdout).trim().to_string();
        assert_eq!(subject, "add feature");
    }

    #[test]
    fn commit_staged_rejects_blank_messages() {
        let (db, child_id, child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("feature.txt"), "feature\n").expect("write");
        run(&child_path, &["add", "feature.txt"]);

        let result = commit_staged_impl(&db, &child_id, "   \n  ");
        assert!(result.is_err(), "blank message should be rejected");
        // The staged file is still staged — a rejected commit must not partially run.
        let changes = worktree_changes_impl(&db, &child_id).expect("changes");
        assert!(changes
            .staged
            .iter()
            .any(|c| c.path == "feature.txt" && c.status == ChangeStatus::Added));
    }

    #[test]
    fn commit_staged_fails_when_nothing_is_staged() {
        let (db, child_id, _child_path, _main_path) = project_with_child();
        // Nothing staged — git refuses with a non-zero exit, the error must
        // surface rather than be swallowed.
        let result = commit_staged_impl(&db, &child_id, "empty commit");
        assert!(result.is_err(), "git should refuse an empty index");
    }

    #[test]
    fn merge_worktree_to_parent_fast_forwards_parent() {
        let (db, child_id, child_path, main_path) = project_with_child();
        std::fs::write(child_path.join("feature.txt"), "feature\n").expect("write");
        commit_all(&child_path, "feature commit");

        merge_worktree_to_parent_impl(&db, &child_id).expect("merge");

        assert_eq!(
            std::fs::read_to_string(main_path.join("feature.txt")).expect("read feature"),
            "feature\n"
        );
        let changes = worktree_changes_impl(&db, &child_id).expect("changes");
        assert!(changes.committed.is_empty());
    }

    #[test]
    fn merge_worktree_to_parent_requires_clean_parent() {
        let (db, child_id, _child_path, main_path) = project_with_child();
        std::fs::write(main_path.join("scratch.txt"), "dirty\n").expect("write dirty");

        let result = merge_worktree_to_parent_impl(&db, &child_id);

        assert!(result.is_err(), "dirty parent should block merge");
    }

    #[test]
    fn merge_worktree_to_parent_reports_conflicts() {
        let (db, child_id, child_path, main_path) = project_with_child();
        std::fs::write(child_path.join("base.txt"), "child\n").expect("write child");
        commit_all(&child_path, "child edits base");
        std::fs::write(main_path.join("base.txt"), "parent\n").expect("write parent");
        commit_all(&main_path, "parent edits base");

        let result = merge_worktree_to_parent_impl(&db, &child_id);

        let message = result.expect_err("merge should conflict").to_string();
        assert!(message.contains("Merge conflicts detected"));
        assert!(worktree_is_dirty(&main_path));
    }
}
