//! Host-side git operations behind the `git` RPC method.
//!
//! These power the Changes view and the index/commit/merge actions. Every
//! request carries the **trusted absolute worktree root** (resolved by the
//! native client from its local DB) plus any DB-derived inputs the host can't
//! look up itself — notably the **parent branch**, which the client resolves
//! from the worktree's recorded parent so the host can compute the fork-point
//! merge-base. The work runs on whichever host owns the socket.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use pragma_constants::{
    BranchSyncStatus, ChangeStatus, ChangedFile, DiffSide, FileDiff, WorktreeChanges,
    WorktreeCommit, WorktreeCommitList,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::process_env;
use crate::{CoreError, CoreResult};

/// Git exclude entry that hides Pragma's worktree storage from the repo.
const PRAGMA_WORKTREES_EXCLUDE: &str = ".pragma/worktrees/";
/// Git exclude entry that keeps local scratchpad documents out of commits.
const PRAGMA_SCRATCHPADS_EXCLUDE: &str = ".pragma/scratchpads/";

/// One worktree's inputs for a merged-status batch check.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedStatusItem {
    /// Caller-chosen key echoed back in the result map (the worktree id).
    pub id: String,
    /// Trusted absolute worktree root.
    pub root: String,
    /// The worktree's own branch.
    pub branch: String,
    /// The parent worktree's branch, or `None` for a parentless/main worktree.
    pub parent_branch: Option<String>,
}

/// Host-computed git metadata needed by the GitHub PR flow.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoInfo {
    /// The repo's `origin` remote URL.
    pub remote_url: String,
    /// The locally-known default branch from `origin/HEAD`, or `main`.
    pub default_branch: String,
    /// The current branch checked out in the worktree.
    pub head_branch: String,
}

/// One checkout under `<project>/.pragma/worktrees/` — a worktree the server
/// may have created headlessly (a phone launching an agent while the desktop
/// app was closed). `id` is the directory name, i.e. the server-minted
/// worktree id.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessWorktree {
    /// The checkout's directory name, used as the worktree id.
    pub id: String,
    /// Absolute checkout path on the host.
    pub path: String,
    /// The branch checked out.
    pub branch: String,
}

/// One git operation request. `root` is always the trusted absolute worktree
/// root; `parent_branch` is the DB-resolved parent branch where a fork-point is
/// needed.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum GitRequest {
    /// Lists committed/staged/unstaged changes for a worktree.
    WorktreeChanges {
        root: String,
        parent_branch: Option<String>,
    },
    /// Batch "is this worktree merged & clean" check.
    MergedStatus { items: Vec<MergedStatusItem> },
    /// Lists commits since the fork point with the parent branch, newest first.
    WorktreeCommits {
        root: String,
        parent_branch: Option<String>,
        limit: u32,
    },
    /// Loads old/new text for one file as changed by a single commit
    /// (first parent → commit).
    CommitFileDiff {
        root: String,
        commit: String,
        path: String,
        old_path: Option<String>,
    },
    /// Loads old/new text for one changed file on a diff side.
    FileDiff {
        root: String,
        path: String,
        side: DiffSide,
        old_path: Option<String>,
        parent_branch: Option<String>,
    },
    /// Discards one unstaged change. **Destructive.**
    DiscardUnstagedFile {
        root: String,
        path: String,
        status: ChangeStatus,
        old_path: Option<String>,
    },
    /// Discards every unstaged change. **Destructive.**
    DiscardAllUnstaged { root: String },
    /// Stages one path.
    StageFile { root: String, path: String },
    /// Stages everything (`git add -A`).
    StageAll { root: String },
    /// Unstages one path (optionally its rename source too).
    UnstageFile {
        root: String,
        path: String,
        old_path: Option<String>,
    },
    /// Unstages everything (`git reset`).
    UnstageAll { root: String },
    /// Commits the staged index with a message.
    CommitStaged { root: String, message: String },
    /// Merges a child worktree's branch into its parent worktree.
    MergeWorktreeToParent {
        parent_root: String,
        parent_branch: String,
        child_root: String,
        child_branch: String,
    },
    /// PR-style three-dot diff (`base...HEAD`) for one file.
    PrFileDiff {
        root: String,
        base: String,
        path: String,
        old_path: Option<String>,
    },
    /// Reads git metadata needed to identify the GitHub repository.
    GithubRepoInfo { root: String },
    /// Reads the last commit subject used as the default PR title.
    GithubDefaultPrTitle { root: String },
    /// Fetches `origin` and reports ahead/behind against the branch upstream.
    GithubFetchAndSync { root: String },
    /// Pulls the current branch, aborting and restoring HEAD on merge conflicts.
    GithubPullBranch { root: String },
    /// Pulls then pushes the current branch to `origin`.
    GithubSyncBranch { root: String },
    /// Syncs the current branch, then merges the latest base repository branch into it.
    GithubMergeBaseBranch {
        root: String,
        base: String,
        base_remote: Option<String>,
    },
    /// Discards conflict-resolution changes and aborts the active merge.
    GithubAbortMerge { root: String },
    /// Returns whether the worktree has an active merge.
    GithubMergeInProgress { root: String },
    /// Pushes the current branch to `origin`, setting the upstream.
    GithubPushBranch { root: String },
    /// Deletes the current branch from `origin`.
    GithubDeleteRemoteBranch { root: String },
    /// Ensures `.pragma/worktrees/` is git-excluded in the repo at `project_root`.
    EnsurePragmaExcluded { project_root: String },
    /// Creates a worktree at `path` on a new `branch`, forked from `parent_root`.
    CreateWorktree {
        parent_root: String,
        branch: String,
        path: String,
    },
    /// Removes the worktree at `worktree_path` from the repo at `repo_root`.
    RemoveWorktree {
        repo_root: String,
        worktree_path: String,
        force: bool,
    },
    /// Hard-deletes a branch ref from a worktree that doesn't have it checked out.
    DeleteBranch { repo_root: String, branch: String },
    /// True when the worktree at `root` has uncommitted/staged/untracked changes.
    IsDirty { root: String },
    /// Lists checkouts under `<project_root>/.pragma/worktrees/` with their
    /// checked-out branches, for headless-worktree adoption.
    ListHeadlessWorktrees { project_root: String },
}

/// Dispatches a `git` RPC payload to the matching operation and returns a JSON
/// response payload.
pub fn handle(payload: Value) -> CoreResult<Value> {
    let request: GitRequest = serde_json::from_value(payload)
        .map_err(|error| CoreError::InvalidPayload(error.to_string()))?;
    if let Some(value) = handle_github_request(&request)? {
        return Ok(value);
    }
    if let Some(value) = handle_lifecycle_request(&request)? {
        return Ok(value);
    }
    match request {
        GitRequest::WorktreeChanges {
            root,
            parent_branch,
        } => to_value(worktree_changes(
            Path::new(&root),
            parent_branch.as_deref(),
        )?),
        GitRequest::MergedStatus { items } => to_value(merged_status(&items)),
        GitRequest::WorktreeCommits {
            root,
            parent_branch,
            limit,
        } => to_value(worktree_commits(
            Path::new(&root),
            parent_branch.as_deref(),
            limit,
        )?),
        GitRequest::CommitFileDiff {
            root,
            commit,
            path,
            old_path,
        } => to_value(commit_file_diff(
            Path::new(&root),
            &commit,
            path,
            old_path.as_deref(),
        )?),
        GitRequest::FileDiff {
            root,
            path,
            side,
            old_path,
            parent_branch,
        } => to_value(file_diff(
            Path::new(&root),
            path,
            side,
            old_path.as_deref(),
            parent_branch.as_deref(),
        )?),
        GitRequest::DiscardUnstagedFile {
            root,
            path,
            status,
            old_path,
        } => to_value(discard_unstaged_file(
            Path::new(&root),
            &path,
            status,
            old_path.as_deref(),
        )?),
        GitRequest::DiscardAllUnstaged { root } => {
            to_value(discard_all_unstaged(Path::new(&root))?)
        }
        GitRequest::StageFile { root, path } => to_value(stage_file(Path::new(&root), &path)?),
        GitRequest::StageAll { root } => to_value(stage_all(Path::new(&root))?),
        GitRequest::UnstageFile {
            root,
            path,
            old_path,
        } => to_value(unstage_file(Path::new(&root), &path, old_path.as_deref())?),
        GitRequest::UnstageAll { root } => to_value(unstage_all(Path::new(&root))?),
        GitRequest::CommitStaged { root, message } => {
            to_value(commit_staged(Path::new(&root), &message)?)
        }
        GitRequest::MergeWorktreeToParent {
            parent_root,
            parent_branch,
            child_root,
            child_branch,
        } => to_value(merge_worktree_to_parent(
            Path::new(&parent_root),
            &parent_branch,
            Path::new(&child_root),
            &child_branch,
        )?),
        GitRequest::PrFileDiff {
            root,
            base,
            path,
            old_path,
        } => to_value(pr_file_diff(
            Path::new(&root),
            &base,
            &path,
            old_path.as_deref(),
        )?),
        _ => unreachable!(),
    }
}

fn handle_github_request(request: &GitRequest) -> CoreResult<Option<Value>> {
    let value = match request {
        GitRequest::GithubRepoInfo { root } => to_value(github_repo_info(Path::new(root))?)?,
        GitRequest::GithubDefaultPrTitle { root } => {
            to_value(github_default_pr_title(Path::new(root)))?
        }
        GitRequest::GithubFetchAndSync { root } => {
            to_value(github_fetch_and_sync(Path::new(root))?)?
        }
        GitRequest::GithubPullBranch { root } => to_value(github_pull_branch(Path::new(root))?)?,
        GitRequest::GithubSyncBranch { root } => to_value(github_sync_branch(Path::new(root))?)?,
        GitRequest::GithubMergeBaseBranch {
            root,
            base,
            base_remote,
        } => to_value(github_merge_base_branch(
            Path::new(root),
            base,
            base_remote.as_deref(),
        )?)?,
        GitRequest::GithubAbortMerge { root } => to_value(github_abort_merge(Path::new(root))?)?,
        GitRequest::GithubMergeInProgress { root } => {
            to_value(github_merge_in_progress(Path::new(root))?)?
        }
        GitRequest::GithubPushBranch { root } => to_value(github_push_branch(Path::new(root))?)?,
        GitRequest::GithubDeleteRemoteBranch { root } => {
            to_value(github_delete_remote_branch(Path::new(root))?)?
        }
        _ => return Ok(None),
    };
    Ok(Some(value))
}

fn handle_lifecycle_request(request: &GitRequest) -> CoreResult<Option<Value>> {
    let value = match request {
        GitRequest::EnsurePragmaExcluded { project_root } => {
            to_value(ensure_pragma_excluded(Path::new(project_root))?)?
        }
        GitRequest::CreateWorktree {
            parent_root,
            branch,
            path,
        } => to_value(create_worktree(
            Path::new(parent_root),
            branch,
            Path::new(path),
        )?)?,
        GitRequest::RemoveWorktree {
            repo_root,
            worktree_path,
            force,
        } => to_value(remove_worktree(
            Path::new(repo_root),
            Path::new(worktree_path),
            *force,
        )?)?,
        GitRequest::DeleteBranch { repo_root, branch } => {
            to_value(delete_branch(Path::new(repo_root), branch)?)?
        }
        GitRequest::IsDirty { root } => to_value(worktree_is_dirty(Path::new(root)))?,
        GitRequest::ListHeadlessWorktrees { project_root } => {
            to_value(list_headless_worktrees(Path::new(project_root)))?
        }
        _ => return Ok(None),
    };
    Ok(Some(value))
}

/// Lists checkouts under `<project_root>/.pragma/worktrees/`: every directory
/// containing a `.git` entry with a named branch checked out. A missing
/// worktrees directory, an unreadable entry, or a detached HEAD yields no row
/// rather than an error — adoption is best-effort.
fn list_headless_worktrees(project_root: &Path) -> Vec<HeadlessWorktree> {
    let Ok(entries) = std::fs::read_dir(project_root.join(PRAGMA_WORKTREES_EXCLUDE)) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.join(".git").exists() {
                return None;
            }
            let branch = current_branch(&path)
                .ok()
                .filter(|branch| branch != "HEAD")?;
            Some(HeadlessWorktree {
                id: entry.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                branch,
            })
        })
        .collect()
}

fn to_value<T: Serialize>(value: T) -> CoreResult<Value> {
    serde_json::to_value(value).map_err(|error| CoreError::Operation(error.to_string()))
}

/// Lists a worktree's changes split into **committed** (since the fork point
/// with the parent branch), **staged** (HEAD → index) and **unstaged** (working
/// tree + untracked).
fn worktree_changes(root: &Path, parent_branch: Option<&str>) -> CoreResult<WorktreeChanges> {
    // The three sections are independent read-only git queries (~8 subprocess
    // spawns total), and this request is polled every couple of seconds per
    // worktree — run them concurrently so the RPC returns in the time of the
    // slowest query instead of their sum.
    let (committed, staged, unstaged) = std::thread::scope(|scope| {
        let committed = scope.spawn(|| committed_changes(root, parent_branch));
        let staged = scope.spawn(|| staged_changes(root));
        let unstaged = scope.spawn(|| unstaged_changes(root));
        (
            join_changes(committed),
            join_changes(staged),
            join_changes(unstaged),
        )
    });
    Ok(WorktreeChanges {
        committed: committed?,
        staged: staged?,
        unstaged: unstaged?,
    })
}

/// Unwraps a scoped changes task, mapping a panic to an operation error.
fn join_changes(
    handle: std::thread::ScopedJoinHandle<'_, CoreResult<Vec<ChangedFile>>>,
) -> CoreResult<Vec<ChangedFile>> {
    handle
        .join()
        .map_err(|_| CoreError::Operation("git query task panicked".to_string()))?
}

/// Lists changes committed since the fork point with the parent branch.
fn committed_changes(root: &Path, parent_branch: Option<&str>) -> CoreResult<Vec<ChangedFile>> {
    let Some(merge_base) = base_merge_base(root, parent_branch)? else {
        return Ok(Vec::new());
    };
    let args = [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        &merge_base,
        "HEAD",
    ];
    let name_status = run_git(root, &args)?;
    let mut changes = parse_name_status(&name_status, DiffSide::Committed);
    let numstat = run_git(root, &numstat_args(&args))?;
    attach_numstat(&mut changes, &parse_numstat(&numstat));
    Ok(changes)
}

/// Record/field separators for the commit-log format string: fields are split
/// by `%x1f` (unit separator) and records end with `%x1e` (record separator) so
/// multi-line trailer values can't be confused with record boundaries.
const LOG_FIELD_SEP: char = '\u{1f}';
const LOG_RECORD_SEP: char = '\u{1e}';

/// Lists commits in the fork-point range (newest first) with their authors,
/// co-authors, and per-commit changed files. At most `limit` commits are
/// returned; `total_count` reports the whole range so the client can page.
fn worktree_commits(
    root: &Path,
    parent_branch: Option<&str>,
    limit: u32,
) -> CoreResult<WorktreeCommitList> {
    let Some(merge_base) = base_merge_base(root, parent_branch)? else {
        return Ok(WorktreeCommitList {
            commits: Vec::new(),
            total_count: 0,
        });
    };
    let range = format!("{merge_base}..HEAD");
    let total_count = git_stdout(root, &["rev-list", "--count", &range])?
        .parse::<u64>()
        .unwrap_or(0);
    let limit_arg = limit.to_string();
    let format = format!(
        "%H{LOG_FIELD_SEP}%h{LOG_FIELD_SEP}%an{LOG_FIELD_SEP}%s{LOG_FIELD_SEP}%(trailers:key=Co-authored-by,valueonly=true){LOG_RECORD_SEP}"
    );
    let format_arg = format!("--format={format}");
    let log = run_git(root, &["log", "-n", &limit_arg, &format_arg, &range])?;
    let mut commits = parse_commit_log(&String::from_utf8_lossy(&log));
    // Each commit's file list is an independent pair of read-only git queries;
    // load them concurrently so a 10-commit page costs one commit's latency.
    let files: Vec<CoreResult<Vec<ChangedFile>>> = std::thread::scope(|scope| {
        let handles: Vec<_> = commits
            .iter()
            .map(|commit| {
                let hash = commit.hash.clone();
                scope.spawn(move || commit_files(root, &hash))
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| CoreError::Operation("git query task panicked".to_string()))?
            })
            .collect()
    });
    for (commit, result) in commits.iter_mut().zip(files) {
        commit.files = result?;
    }
    Ok(WorktreeCommitList {
        commits,
        total_count,
    })
}

/// Parses `git log` output in the `LOG_FIELD_SEP`/`LOG_RECORD_SEP` format into
/// commits (without files). Malformed records are skipped.
fn parse_commit_log(log: &str) -> Vec<WorktreeCommit> {
    log.split(LOG_RECORD_SEP)
        .filter_map(|record| {
            let record = record.trim_matches(['\n', ' ']);
            let mut fields = record.split(LOG_FIELD_SEP);
            let hash = fields.next()?.trim();
            if hash.is_empty() {
                return None;
            }
            let short_hash = fields.next()?.trim().to_string();
            let author = fields.next()?.trim().to_string();
            let subject = fields.next()?.trim().to_string();
            let trailers = fields.next().unwrap_or_default();
            let mut authors = vec![author];
            for name in trailers.lines().filter_map(trailer_author_name) {
                if !authors.iter().any(|existing| existing == &name) {
                    authors.push(name);
                }
            }
            Some(WorktreeCommit {
                hash: hash.to_string(),
                short_hash,
                subject,
                authors,
                files: Vec::new(),
            })
        })
        .collect()
}

/// Extracts the display name from a `Co-authored-by` trailer value
/// (`Name <email>` → `Name`). Empty values yield `None`.
fn trailer_author_name(value: &str) -> Option<String> {
    let name = value.split('<').next().unwrap_or(value).trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Lists the files one commit changed relative to its first parent.
fn commit_files(root: &Path, hash: &str) -> CoreResult<Vec<ChangedFile>> {
    let parent = format!("{hash}^");
    let args = [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        &parent,
        hash,
    ];
    let name_status = run_git(root, &args)?;
    let mut changes = parse_name_status(&name_status, DiffSide::Committed);
    let numstat = run_git(root, &numstat_args(&args))?;
    attach_numstat(&mut changes, &parse_numstat(&numstat));
    Ok(changes)
}

/// Loads old/new text for one file as changed by a single commit
/// (first parent → commit).
fn commit_file_diff(
    root: &Path,
    commit: &str,
    path: String,
    old_path: Option<&str>,
) -> CoreResult<FileDiff> {
    if commit.is_empty() || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(CoreError::InvalidPayload(format!(
            "invalid commit hash: {commit}"
        )));
    }
    let parent = format!("{commit}^");
    if diff_is_binary(root, &[&parent, commit], &path) {
        return Ok(binary_diff(path));
    }
    let old_ref_path = old_path.unwrap_or(&path);
    let (old_text, new_text) = load_diff_sides(
        || git_show(root, &format!("{parent}:{old_ref_path}")).unwrap_or_default(),
        || git_show(root, &format!("{commit}:{path}")).unwrap_or_default(),
    );
    Ok(FileDiff {
        path,
        old_text,
        new_text,
        binary: false,
    })
}

/// Lists HEAD → index (staged) changes.
fn staged_changes(root: &Path) -> CoreResult<Vec<ChangedFile>> {
    let args = ["diff", "--name-status", "-z", "--find-renames", "--cached"];
    let name_status = run_git(root, &args)?;
    let mut staged = parse_name_status(&name_status, DiffSide::Staged);
    let numstat = run_git(root, &numstat_args(&args))?;
    attach_numstat(&mut staged, &parse_numstat(&numstat));
    Ok(staged)
}

/// Lists working-tree (unstaged) changes plus untracked files.
fn unstaged_changes(root: &Path) -> CoreResult<Vec<ChangedFile>> {
    let args = ["diff", "--name-status", "-z", "--find-renames"];
    let name_status = run_git(root, &args)?;
    let mut unstaged = parse_name_status(&name_status, DiffSide::Unstaged);
    let numstat = run_git(root, &numstat_args(&args))?;
    attach_numstat(&mut unstaged, &parse_numstat(&numstat));

    let untracked = run_git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    for path in untracked.split(|byte| *byte == 0).filter(|s| !s.is_empty()) {
        let path = String::from_utf8_lossy(path).into_owned();
        let additions = untracked_line_count(root, &path);
        unstaged.push(ChangedFile {
            path,
            old_path: None,
            status: ChangeStatus::Untracked,
            side: DiffSide::Unstaged,
            additions,
            deletions: Some(0),
        });
    }
    Ok(unstaged)
}

/// Batch merged-status: returns `id -> merged` for each item. A worktree that
/// errors is reported as not-merged so one bad checkout never fails the batch.
fn merged_status(items: &[MergedStatusItem]) -> HashMap<String, bool> {
    // Each item targets its own worktree (own index, own checkout), and each
    // check runs up to three git subprocesses. The sidebar polls this batch, so
    // check the worktrees concurrently: the batch costs one worktree's latency
    // instead of the sum across all of them.
    std::thread::scope(|scope| {
        let handles: Vec<_> = items
            .iter()
            .map(|item| {
                scope.spawn(move || (item.id.clone(), worktree_is_merged(item).unwrap_or(false)))
            })
            .collect();
        handles
            .into_iter()
            .zip(items)
            .map(|(handle, item)| handle.join().unwrap_or_else(|_| (item.id.clone(), false)))
            .collect()
    })
}

/// True when a worktree's work is in its parent branch and its tree is clean.
/// A fresh child (no commits beyond creation) is **not** merged.
fn worktree_is_merged(item: &MergedStatusItem) -> CoreResult<bool> {
    let root = Path::new(&item.root);
    if worktree_is_dirty(root) {
        return Ok(false);
    }
    let Some(parent_branch) = item.parent_branch.as_deref() else {
        return Ok(false);
    };
    if !branch_has_commits(root, &item.branch)? {
        return Ok(false);
    }
    let output = process_env::git()
        .args([
            "-C",
            &path_string(root),
            "merge-base",
            "--is-ancestor",
            "HEAD",
            parent_branch,
        ])
        .output()?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(CoreError::Operation(command_output(
            &output.stdout,
            &output.stderr,
        ))),
    }
}

/// True when the branch has at least one commit beyond its creation entry.
/// Falls back to `true` when the reflog is unavailable.
fn branch_has_commits(root: &Path, branch: &str) -> CoreResult<bool> {
    let output = process_env::git()
        .args([
            "-C",
            &path_string(root),
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

/// Loads a diff's two sides concurrently — each side is an independent git
/// subprocess (or file read), so opening a diff costs the slower side instead
/// of both in sequence.
fn load_diff_sides(
    old: impl FnOnce() -> String + Send,
    new: impl FnOnce() -> String + Send,
) -> (String, String) {
    std::thread::scope(|scope| {
        let old = scope.spawn(old);
        let new_text = new();
        (old.join().unwrap_or_default(), new_text)
    })
}

/// Reads a worktree file as lossy UTF-8, or empty when missing/unreadable.
fn read_worktree_text(root: &Path, path: &str) -> String {
    std::fs::read(root.join(path))
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

/// Loads old/new text for one changed file on the given diff side.
fn file_diff(
    root: &Path,
    path: String,
    side: DiffSide,
    old_path: Option<&str>,
    parent_branch: Option<&str>,
) -> CoreResult<FileDiff> {
    match side {
        DiffSide::Committed => {
            let Some(merge_base) = base_merge_base(root, parent_branch)? else {
                return Ok(empty_diff(path));
            };
            if diff_is_binary(root, &[&merge_base, "HEAD"], &path) {
                return Ok(binary_diff(path));
            }
            let old_ref_path = old_path.unwrap_or(&path);
            let (old_text, new_text) = load_diff_sides(
                || git_show(root, &format!("{merge_base}:{old_ref_path}")).unwrap_or_default(),
                || git_show(root, &format!("HEAD:{path}")).unwrap_or_default(),
            );
            Ok(FileDiff {
                path,
                old_text,
                new_text,
                binary: false,
            })
        }
        DiffSide::Staged => {
            if diff_is_binary(root, &["--cached"], &path) {
                return Ok(binary_diff(path));
            }
            let old_ref_path = old_path.unwrap_or(&path);
            let (old_text, new_text) = load_diff_sides(
                || git_show(root, &format!("HEAD:{old_ref_path}")).unwrap_or_default(),
                || git_show(root, &format!(":{path}")).unwrap_or_default(),
            );
            Ok(FileDiff {
                path,
                old_text,
                new_text,
                binary: false,
            })
        }
        DiffSide::Unstaged => {
            if diff_is_binary(root, &[], &path) {
                return Ok(binary_diff(path));
            }
            let (old_text, new_text) = load_diff_sides(
                || git_show(root, &format!(":{path}")).unwrap_or_default(),
                || read_worktree_text(root, &path),
            );
            Ok(FileDiff {
                path,
                old_text,
                new_text,
                binary: false,
            })
        }
        DiffSide::Worktree => {
            let base_ref =
                base_merge_base(root, parent_branch)?.unwrap_or_else(|| "HEAD".to_string());
            if diff_is_binary(root, &[&base_ref], &path) {
                return Ok(binary_diff(path));
            }
            let old_ref_path = old_path.unwrap_or(&path);
            let (old_text, new_text) = load_diff_sides(
                || git_show(root, &format!("{base_ref}:{old_ref_path}")).unwrap_or_default(),
                || read_worktree_text(root, &path),
            );
            Ok(FileDiff {
                path,
                old_text,
                new_text,
                binary: false,
            })
        }
    }
}

/// Loads old/new text for one file in a PR-style three-dot range `base...HEAD`.
fn pr_file_diff(
    root: &Path,
    base: &str,
    path: &str,
    old_path: Option<&str>,
) -> CoreResult<FileDiff> {
    crate::fs::resolve_in_worktree(root, path)?;
    let merge_base = merge_base(root, base, "HEAD").unwrap_or_else(|| base.to_string());
    if diff_is_binary(root, &[&merge_base, "HEAD"], path) {
        return Ok(binary_diff(path.to_string()));
    }
    let old_ref_path = old_path.unwrap_or(path);
    let old_text = git_show(root, &format!("{merge_base}:{old_ref_path}")).unwrap_or_default();
    let new_text = git_show(root, &format!("HEAD:{path}")).unwrap_or_default();
    Ok(FileDiff {
        path: path.to_string(),
        old_text,
        new_text,
        binary: false,
    })
}

/// Reads the remote/default/head metadata used by the GitHub PR flow.
fn github_repo_info(root: &Path) -> CoreResult<GithubRepoInfo> {
    Ok(GithubRepoInfo {
        remote_url: git_stdout(root, &["remote", "get-url", "origin"])?,
        default_branch: default_branch(root),
        head_branch: current_branch(root)?,
    })
}

/// Reads the latest commit subject, returning an empty title if the repo has no commits.
fn github_default_pr_title(root: &Path) -> String {
    git_stdout(root, &["log", "-1", "--pretty=%s"]).unwrap_or_default()
}

/// Fetches origin and reports the current branch's ahead/behind status.
fn github_fetch_and_sync(root: &Path) -> CoreResult<BranchSyncStatus> {
    let branch = current_branch(root)?;
    if git_stdout(root, &["remote", "get-url", "origin"]).is_err() {
        return Ok(BranchSyncStatus {
            branch,
            ahead: 0,
            behind: 0,
            has_upstream: false,
        });
    }
    git_stdout(root, &["fetch", "origin"])?;
    let Some(upstream) = git_stdout(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok() else {
        return Ok(BranchSyncStatus {
            branch,
            ahead: 0,
            behind: 0,
            has_upstream: false,
        });
    };
    let counts = git_stdout(
        root,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{upstream}...HEAD"),
        ],
    )?;
    let (behind, ahead) = parse_ahead_behind(&counts);
    Ok(BranchSyncStatus {
        branch,
        ahead,
        behind,
        has_upstream: true,
    })
}

/// Pulls remote commits into the current branch. Dirty worktrees are refused;
/// conflicted merges are aborted so local commits and files remain unchanged.
fn github_pull_branch(root: &Path) -> CoreResult<()> {
    if worktree_is_dirty(root) {
        return Err(CoreError::InvalidPayload(
            "Cannot pull with uncommitted changes. Commit or stash them first; no files were changed."
                .to_string(),
        ));
    }
    let branch = current_branch(root)?;
    git_stdout(root, &["fetch", "origin"])?;
    let target = git_stdout(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok()
    .or_else(|| existing_remote_branch(root, &branch));
    let Some(target) = target else {
        return Ok(());
    };

    let output = process_env::git()
        .args(["-C", &path_string(root), "merge", "--no-edit", &target])
        .output()?;
    if output.status.success() {
        return Ok(());
    }
    if has_unmerged_paths(root)? {
        git_stdout(root, &["merge", "--abort"])?;
        return Err(CoreError::Operation(
            "Remote changes conflict with local commits. Pull was aborted; local commits and files were preserved."
                .to_string(),
        ));
    }
    Err(CoreError::Operation(command_output(
        &output.stdout,
        &output.stderr,
    )))
}

/// Pulls first, then pushes the resulting branch to origin.
fn github_sync_branch(root: &Path) -> CoreResult<()> {
    github_pull_branch(root)?;
    github_push_branch(root)
}

/// Syncs the PR head, then merges the latest origin base into it. Returns true
/// when Git leaves conflicts in the worktree for the user to resolve.
fn github_merge_base_branch(
    root: &Path,
    base: &str,
    base_remote: Option<&str>,
) -> CoreResult<bool> {
    git_stdout(root, &["check-ref-format", "--branch", base])?;
    github_sync_branch(root)?;

    let base_ref = if let Some(remote) = base_remote {
        git_stdout(root, &["fetch", "--", remote, base])?;
        "FETCH_HEAD".to_string()
    } else {
        git_stdout(root, &["fetch", "origin"])?;
        let base_ref = format!("refs/remotes/origin/{base}");
        git_stdout(root, &["rev-parse", "--verify", &base_ref])?;
        base_ref
    };
    let output = process_env::git()
        .args(["-C", &path_string(root), "merge", "--no-edit", &base_ref])
        .output()?;
    if output.status.success() {
        github_push_branch(root)?;
        return Ok(false);
    }
    if has_unmerged_paths(root)? {
        return Ok(true);
    }
    Err(CoreError::Operation(command_output(
        &output.stdout,
        &output.stderr,
    )))
}

/// Discards all merge-conflict resolution changes and restores the pre-merge tree.
fn github_abort_merge(root: &Path) -> CoreResult<()> {
    if !github_merge_in_progress(root)? {
        return Err(CoreError::InvalidPayload(
            "No merge is in progress.".to_string(),
        ));
    }
    git_stdout(root, &["merge", "--abort"]).map(|_| ())
}

/// Returns whether Git has an active merge for this worktree.
fn github_merge_in_progress(root: &Path) -> CoreResult<bool> {
    let merge_head = process_env::git()
        .args([
            "-C",
            &path_string(root),
            "rev-parse",
            "-q",
            "--verify",
            "MERGE_HEAD",
        ])
        .output()?;
    Ok(merge_head.status.success())
}

/// Pushes the current branch to origin and sets its upstream.
fn github_push_branch(root: &Path) -> CoreResult<()> {
    let branch = current_branch(root)?;
    git_stdout(root, &["push", "-u", "origin", &branch]).map(|_| ())
}

fn existing_remote_branch(root: &Path, branch: &str) -> Option<String> {
    let remote = format!("origin/{branch}");
    git_stdout(root, &["rev-parse", "--verify", &remote])
        .ok()
        .map(|_| remote)
}

/// Deletes the current branch from origin.
fn github_delete_remote_branch(root: &Path) -> CoreResult<()> {
    let branch = current_branch(root)?;
    git_stdout(root, &["push", "origin", "--delete", &branch]).map(|_| ())
}

/// Discards a single unstaged change, reverting the working tree to the index.
fn discard_unstaged_file(
    root: &Path,
    path: &str,
    status: ChangeStatus,
    old_path: Option<&str>,
) -> CoreResult<()> {
    match status {
        ChangeStatus::Untracked => remove_untracked(root, path)?,
        ChangeStatus::Renamed => {
            if let Some(old) = old_path {
                git_restore(root, old)?;
            }
            remove_untracked(root, path)?;
        }
        ChangeStatus::Added | ChangeStatus::Modified | ChangeStatus::Deleted => {
            git_restore(root, path)?;
        }
    }
    Ok(())
}

/// Discards every unstaged change: restores tracked files and sweeps untracked.
fn discard_all_unstaged(root: &Path) -> CoreResult<()> {
    run_git(root, &["restore", "--", "."])?;
    run_git(root, &["clean", "-fd"])?;
    Ok(())
}

/// Stages a single path (`git add`).
fn stage_file(root: &Path, path: &str) -> CoreResult<()> {
    crate::fs::resolve_in_worktree(root, path)?;
    run_git(root, &["add", "--", path])?;
    Ok(())
}

/// Stages everything (`git add -A`).
fn stage_all(root: &Path) -> CoreResult<()> {
    run_git(root, &["add", "-A"])?;
    Ok(())
}

/// Unstages a single path (and its rename source) from the index.
fn unstage_file(root: &Path, path: &str, old_path: Option<&str>) -> CoreResult<()> {
    git_restore_staged(root, path)?;
    if let Some(old) = old_path {
        git_restore_staged(root, old)?;
    }
    Ok(())
}

/// Unstages everything, resetting the index to HEAD (`git reset`).
fn unstage_all(root: &Path) -> CoreResult<()> {
    run_git(root, &["reset", "-q", "HEAD", "--", "."])?;
    Ok(())
}

/// Commits the staged index. Empty messages are rejected up front.
fn commit_staged(root: &Path, message: &str) -> CoreResult<()> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidPayload(
            "commit message is empty".to_string(),
        ));
    }
    run_git(root, &["commit", "-m", trimmed])?;
    Ok(())
}

/// Merges a child worktree's branch into its parent worktree. Both must be clean.
fn merge_worktree_to_parent(
    parent_root: &Path,
    parent_branch: &str,
    child_root: &Path,
    child_branch: &str,
) -> CoreResult<()> {
    if worktree_is_dirty(parent_root) {
        return Err(CoreError::InvalidPayload(format!(
            "parent worktree {parent_branch} has uncommitted changes; commit, stash, or discard them before merging"
        )));
    }
    if worktree_is_dirty(child_root) {
        return Err(CoreError::InvalidPayload(
            "commit or discard this worktree's staged, unstaged, and untracked changes before merging"
                .to_string(),
        ));
    }

    let output = process_env::git()
        .args([
            "-C",
            &path_string(parent_root),
            "merge",
            "--no-edit",
            child_branch,
        ])
        .output()?;
    if output.status.success() {
        return Ok(());
    }
    if has_unmerged_paths(parent_root)? {
        let parent_path = path_string(parent_root);
        return Err(CoreError::Operation(format!(
            "Merge conflicts detected in {parent_branch}. Resolve them in an IDE in {parent_path} or run `git -C \"{parent_path}\" status`, fix the conflicts, then run `git -C \"{parent_path}\" merge --continue`. To cancel, run `git -C \"{parent_path}\" merge --abort`."
        )));
    }
    Err(CoreError::Operation(command_output(
        &output.stdout,
        &output.stderr,
    )))
}

/// Asks git where the repository keeps its shared metadata. Relative answers
/// resolve against `path`, which is the directory git ran in.
fn git_common_dir(path: &Path) -> CoreResult<PathBuf> {
    let raw = PathBuf::from(
        String::from_utf8_lossy(&run_git(path, &["rev-parse", "--git-common-dir"])?)
            .trim()
            .to_string(),
    );
    let absolute = if raw.is_absolute() {
        raw
    } else {
        path.join(raw)
    };
    Ok(pragma_platform::path::canonicalize(absolute)?)
}

/// Ensures Pragma's local worktrees and scratchpads are excluded via the repository's
/// `info/exclude`, migrating a legacy broad `.pragma/` entry to the narrower
/// paths. Idempotent.
fn ensure_pragma_excluded(project_path: &Path) -> CoreResult<()> {
    // Ask git for the git dir instead of assuming `<project>/.git`. Creating
    // that directory ourselves would leave behind a `.git` git does *not*
    // recognise as a repository, and discovery would then walk straight past it
    // to an ancestor repo — every git view of this project would report the
    // ancestor's index.
    let info = git_common_dir(project_path)?.join("info");
    std::fs::create_dir_all(&info)?;
    let exclude = info.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    let mut has_worktrees_exclude = false;
    let mut has_scratchpads_exclude = false;
    let mut changed = false;
    let mut lines = Vec::new();
    for line in existing.lines() {
        match line.trim() {
            ".pragma/" => changed = true,
            PRAGMA_WORKTREES_EXCLUDE => {
                has_worktrees_exclude = true;
                lines.push(line.to_string());
            }
            PRAGMA_SCRATCHPADS_EXCLUDE => {
                has_scratchpads_exclude = true;
                lines.push(line.to_string());
            }
            _ => lines.push(line.to_string()),
        }
    }
    if !has_worktrees_exclude {
        lines.push(PRAGMA_WORKTREES_EXCLUDE.to_string());
        changed = true;
    }
    if !has_scratchpads_exclude {
        lines.push(PRAGMA_SCRATCHPADS_EXCLUDE.to_string());
        changed = true;
    }
    if changed {
        std::fs::write(exclude, format!("{}\n", lines.join("\n")))?;
    }
    Ok(())
}

/// Creates a worktree at `path` on a new `branch`, forked from `parent_root`.
fn create_worktree(parent_root: &Path, branch: &str, path: &Path) -> CoreResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let output = process_env::git()
        .args([
            "-C",
            &path_string(parent_root),
            "worktree",
            "add",
            "-b",
            branch,
            &path_string(path),
        ])
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(CoreError::Operation(stderr(&output.stderr)))
    }
}

/// Removes a worktree, tolerating drifted admin state by pruning stale entries
/// and deleting any orphaned directory so the caller can still drop its DB row.
fn remove_worktree(repo_root: &Path, worktree_path: &Path, force: bool) -> CoreResult<()> {
    if !worktree_path.exists() {
        return prune_worktrees(repo_root);
    }
    let mut args: Vec<String> = vec![
        "-C".to_string(),
        path_string(repo_root),
        "worktree".to_string(),
        "remove".to_string(),
    ];
    if force {
        args.push("--force".to_string());
    }
    args.push(path_string(worktree_path));
    let output = process_env::git().args(&args).output()?;
    if output.status.success() {
        return Ok(());
    }
    let message = String::from_utf8_lossy(&output.stderr);
    if message.contains("not a working tree")
        || message.contains("not a git worktree")
        || message.contains("not a git repository")
    {
        // Git may already have removed the main worktree or its metadata after a
        // merge, leaving no repository from which to prune. Disk cleanup still
        // lets Pragma remove the stale worktree record.
        if let Err(error) = prune_worktrees(repo_root) {
            eprintln!(
                "pragma-core: failed to prune orphaned worktree metadata from {}: {error}",
                repo_root.display()
            );
        }
        if worktree_path.exists() {
            if let Err(error) = std::fs::remove_dir_all(worktree_path) {
                eprintln!(
                    "pragma-core: failed to remove orphaned worktree {}: {error}",
                    worktree_path.display()
                );
            }
        }
        return Ok(());
    }
    Err(CoreError::Operation(message.trim().to_string()))
}

/// Prunes stale worktree administrative entries (`git worktree prune`).
fn prune_worktrees(repo_root: &Path) -> CoreResult<()> {
    let output = process_env::git()
        .args(["-C", &path_string(repo_root), "worktree", "prune"])
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(CoreError::Operation(stderr(&output.stderr)))
    }
}

/// Hard-deletes a branch ref via `git branch -D <name>`.
fn delete_branch(repo_root: &Path, branch: &str) -> CoreResult<()> {
    let output = process_env::git()
        .args(["-C", &path_string(repo_root), "branch", "-D", branch])
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(CoreError::Operation(stderr(&output.stderr)))
    }
}

/// True when the worktree has uncommitted, staged, or untracked changes.
fn worktree_is_dirty(path: &Path) -> bool {
    let output = process_env::git()
        .args([
            "-C",
            &path_string(path),
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

fn git_restore_staged(root: &Path, path: &str) -> CoreResult<()> {
    crate::fs::resolve_in_worktree(root, path)?;
    run_git(root, &["restore", "--staged", "--", path])?;
    Ok(())
}

fn git_restore(root: &Path, path: &str) -> CoreResult<()> {
    crate::fs::resolve_in_worktree(root, path)?;
    run_git(root, &["restore", "--", path])?;
    Ok(())
}

fn remove_untracked(root: &Path, path: &str) -> CoreResult<()> {
    let target = crate::fs::resolve_in_worktree(root, path)?;
    if target.is_dir() {
        std::fs::remove_dir_all(&target)?;
    } else if target.exists() {
        std::fs::remove_file(&target)?;
    }
    Ok(())
}

fn has_unmerged_paths(root: &Path) -> CoreResult<bool> {
    let output = process_env::git()
        .args([
            "-C",
            &path_string(root),
            "diff",
            "--name-only",
            "--diff-filter=U",
        ])
        .output()?;
    if output.status.success() {
        Ok(!output.stdout.is_empty())
    } else {
        Err(CoreError::Operation(stderr(&output.stderr)))
    }
}

/// Resolves the fork-point merge-base of `HEAD` and the parent branch. A
/// parentless worktree falls back to its upstream/current remote branch so
/// committed changes on main and externally-created branches remain visible.
fn base_merge_base(root: &Path, parent_branch: Option<&str>) -> CoreResult<Option<String>> {
    let comparison_ref = parent_branch
        .map(str::to_string)
        .or_else(|| remote_comparison_ref(root));
    let Some(comparison_ref) = comparison_ref else {
        return Ok(None);
    };
    let output = process_env::git()
        .arg("-C")
        .arg(path_string(root))
        .args(["merge-base", "HEAD", &comparison_ref])
        .output()?;
    if !output.status.success() {
        return Ok(None);
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!sha.is_empty()).then_some(sha))
}

fn remote_comparison_ref(root: &Path) -> Option<String> {
    git_stdout(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok()
    .or_else(|| {
        current_branch(root)
            .ok()
            .and_then(|branch| existing_remote_branch(root, &branch))
    })
    .or_else(|| existing_remote_branch(root, &default_branch(root)))
}

fn merge_base(root: &Path, a: &str, b: &str) -> Option<String> {
    let output = process_env::git()
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
        let mut parts = line.splitn(3, |byte| *byte == b'\t');
        let Some(added) = parts.next() else { continue };
        let Some(removed) = parts.next() else {
            continue;
        };
        let Some(rest) = parts.next() else { continue };
        let additions = if added == b"-" { None } else { atoi(added) };
        let deletions = if removed == b"-" { None } else { atoi(removed) };

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

fn untracked_line_count(root: &Path, path: &str) -> Option<u64> {
    crate::fs::resolve_in_worktree(root, path).ok()?;
    let bytes = std::fs::read(root.join(path)).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    Some(text.bytes().filter(|byte| *byte == b'\n').count() as u64)
}

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

fn diff_is_binary(root: &Path, revs: &[&str], path: &str) -> bool {
    let mut command = process_env::git();
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

fn git_show(root: &Path, spec: &str) -> Option<String> {
    let output = process_env::git()
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

fn current_branch(root: &Path) -> CoreResult<String> {
    let branch = git_stdout(root, &["branch", "--show-current"])?;
    Ok(if branch.is_empty() {
        "HEAD".to_string()
    } else {
        branch
    })
}

fn default_branch(root: &Path) -> String {
    git_stdout(
        root,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .and_then(|head| head.strip_prefix("origin/").map(str::to_string))
    .unwrap_or_else(|| "main".to_string())
}

fn git_stdout(root: &Path, args: &[&str]) -> CoreResult<String> {
    Ok(String::from_utf8_lossy(&run_git(root, args)?)
        .trim()
        .to_string())
}

fn run_git(root: &Path, args: &[&str]) -> CoreResult<Vec<u8>> {
    let output = process_env::git()
        .arg("-C")
        .arg(path_string(root))
        .args(args)
        .output()?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(CoreError::Operation(stderr(&output.stderr)))
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

fn stderr(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn command_output(stdout: &[u8], stderr_bytes: &[u8]) -> String {
    let stderr_text = stderr(stderr_bytes);
    if !stderr_text.is_empty() {
        return stderr_text;
    }
    String::from_utf8_lossy(stdout).trim().to_string()
}

fn parse_ahead_behind(output: &str) -> (u64, u64) {
    let mut fields = output.split_whitespace();
    let behind = fields.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let ahead = fields.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    (behind, ahead)
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command;

    use pragma_constants::{ChangeStatus, DiffSide};
    use tempfile::{tempdir, TempDir};

    use super::{
        commit_file_diff, commit_staged, discard_all_unstaged, discard_unstaged_file,
        ensure_pragma_excluded, file_diff, github_abort_merge, github_fetch_and_sync,
        github_merge_base_branch, github_merge_in_progress, github_pull_branch, github_sync_branch,
        has_unmerged_paths, list_headless_worktrees, merge_worktree_to_parent, merged_status,
        stage_file, unstage_file, worktree_changes, worktree_commits, worktree_is_dirty,
        MergedStatusItem, PRAGMA_SCRATCHPADS_EXCLUDE, PRAGMA_WORKTREES_EXCLUDE,
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

    /// Initializes a test repo with line-ending handling pinned in its own config.
    ///
    /// Repo-local config is required rather than `git -c` on the test's own
    /// commands: the functions under test shell out to `git checkout`/`pull`
    /// themselves, and those inherit only what the repository config says. Git
    /// for Windows defaults `core.autocrlf=true` system-wide, which rewrites
    /// checked-out fixtures to CRLF and fails every `"…\n"` assertion here.
    fn init_repo(dir: &Path, args: &[&str]) {
        run(dir, args);
        run(dir, &["config", "core.autocrlf", "false"]);
        run(dir, &["config", "core.eol", "lf"]);
    }

    /// Excluding must never fabricate a `.git` git would not recognise: git
    /// discovery walks straight past such a directory to the ancestor repo, and
    /// the project's Changes view then reports the ancestor's index as its own.
    #[test]
    fn excluding_a_non_repo_creates_no_git_dir() {
        let dir = tempdir().expect("tempdir");
        init_repo(dir.path(), &["init", "-b", "main"]);
        let nested = dir.path().join("scratch");
        std::fs::create_dir(&nested).expect("nested dir");

        ensure_pragma_excluded(&nested).expect("exclude resolves the ancestor's git dir");

        assert!(
            !nested.join(".git").exists(),
            "a non-repo directory must not gain a .git of its own"
        );
        let exclude =
            std::fs::read_to_string(dir.path().join(".git/info/exclude")).expect("exclude file");
        assert!(exclude
            .lines()
            .any(|line| line.trim() == PRAGMA_WORKTREES_EXCLUDE));
        assert!(exclude
            .lines()
            .any(|line| line.trim() == PRAGMA_SCRATCHPADS_EXCLUDE));
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

    fn stdout(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git command");
        assert!(output.status.success(), "git {args:?} failed");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn project_with_remote() -> (TempDir, TempDir, TempDir) {
        let remote = tempdir().expect("remote tempdir");
        init_repo(remote.path(), &["init", "--bare"]);

        let local = tempdir().expect("local tempdir");
        init_repo(local.path(), &["init", "-b", "main"]);
        run(local.path(), &["config", "user.email", "test@example.com"]);
        run(local.path(), &["config", "user.name", "Test"]);
        run(
            local.path(),
            &[
                "remote",
                "add",
                "origin",
                remote.path().to_string_lossy().as_ref(),
            ],
        );
        std::fs::write(local.path().join("base.txt"), "base\n").expect("write base");
        commit_all(local.path(), "base commit");
        run(local.path(), &["push", "-u", "origin", "main"]);
        run(remote.path(), &["symbolic-ref", "HEAD", "refs/heads/main"]);

        let peer = tempdir().expect("peer tempdir");
        run(
            peer.path(),
            &["clone", remote.path().to_string_lossy().as_ref(), "."],
        );
        run(peer.path(), &["config", "user.email", "test@example.com"]);
        run(peer.path(), &["config", "user.name", "Test"]);
        (remote, local, peer)
    }

    /// Builds a `main` worktree plus a `feature` child forked from main and
    /// returns `(child_path, main_path)`. The parent branch is always `main`.
    fn project_with_child() -> (std::path::PathBuf, std::path::PathBuf) {
        let main = tempdir().expect("tempdir");
        let main_path = main.path().to_path_buf();
        init_repo(&main_path, &["init", "-b", "main"]);
        run(&main_path, &["config", "user.email", "test@example.com"]);
        run(&main_path, &["config", "user.name", "Test"]);
        std::fs::write(main_path.join("base.txt"), "base\n").expect("write base");
        commit_all(&main_path, "base commit");

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
        (child_path, main_path)
    }

    #[test]
    fn lists_headless_worktrees_under_pragma_dir() {
        let project = tempdir().expect("tempdir");
        let project_path = project.path().to_path_buf();
        init_repo(&project_path, &["init", "-b", "main"]);
        run(&project_path, &["config", "user.email", "test@example.com"]);
        run(&project_path, &["config", "user.name", "Test"]);
        std::fs::write(project_path.join("base.txt"), "base\n").expect("write base");
        commit_all(&project_path, "base commit");

        let worktrees_dir = project_path.join(".pragma/worktrees");
        std::fs::create_dir_all(&worktrees_dir).expect("worktrees dir");
        let checkout = worktrees_dir.join("wt-1");
        run(
            &project_path,
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                checkout.to_string_lossy().as_ref(),
            ],
        );
        // A stray non-git directory is ignored.
        std::fs::create_dir_all(worktrees_dir.join("not-a-repo")).expect("stray dir");

        let listed = list_headless_worktrees(&project_path);
        assert_eq!(listed.len(), 1);
        let entry = listed.first().expect("one entry");
        assert_eq!(entry.id, "wt-1");
        assert_eq!(entry.branch, "feature");
        // Compare as paths, not strings. `PRAGMA_WORKTREES_EXCLUDE` carries a
        // trailing slash (it doubles as a git exclude pattern), which Windows
        // counts as a separator, so `read_dir` yields `…\.pragma/worktrees/wt-1`
        // while this test's join yields `…\.pragma/worktrees\wt-1`. Both name the
        // same file, and `Path` equality treats `/` and `\` as equivalent there.
        assert_eq!(Path::new(&entry.path), checkout.as_path());
    }

    #[test]
    fn headless_listing_is_empty_without_worktrees_dir() {
        let project = tempdir().expect("tempdir");
        assert!(list_headless_worktrees(project.path()).is_empty());
    }

    #[test]
    fn committed_list_uses_fork_point_not_parent_tip() {
        let (child_path, main_path) = project_with_child();
        std::fs::write(child_path.join("feature.txt"), "feature\n").expect("write feature");
        commit_all(&child_path, "feature commit");
        std::fs::write(main_path.join("main-only.txt"), "main\n").expect("write main-only");
        commit_all(&main_path, "main moves on");

        let changes = worktree_changes(&child_path, Some("main")).expect("changes");
        assert!(changes
            .committed
            .iter()
            .any(|c| c.path == "feature.txt" && c.status == ChangeStatus::Added));
        assert!(!changes.committed.iter().any(|c| c.path == "base.txt"));
        assert!(!changes.committed.iter().any(|c| c.path == "main-only.txt"));
    }

    #[test]
    fn worktree_commits_lists_commits_with_files_and_coauthors() {
        let (child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("one.txt"), "one\n").expect("write one");
        run(&child_path, &["add", "-A"]);
        run(
            &child_path,
            &[
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "commit",
                "-m",
                "first commit\n\nCo-authored-by: Pair <pair@example.com>",
            ],
        );
        std::fs::write(child_path.join("two.txt"), "two\n").expect("write two");
        commit_all(&child_path, "second commit");

        let list = worktree_commits(&child_path, Some("main"), 10).expect("commits");
        assert_eq!(list.total_count, 2);
        assert_eq!(list.commits.len(), 2);
        let newest = &list.commits[0];
        assert_eq!(newest.subject, "second commit");
        assert_eq!(newest.short_hash.len(), 7);
        assert!(newest
            .files
            .iter()
            .any(|f| f.path == "two.txt" && f.status == ChangeStatus::Added));
        assert!(!newest.files.iter().any(|f| f.path == "one.txt"));
        let oldest = &list.commits[1];
        assert_eq!(oldest.authors, vec!["Test".to_string(), "Pair".to_string()]);
        assert!(oldest.files.iter().any(|f| f.path == "one.txt"));

        let paged = worktree_commits(&child_path, Some("main"), 1).expect("commits");
        assert_eq!(paged.total_count, 2);
        assert_eq!(paged.commits.len(), 1);
        assert_eq!(paged.commits[0].subject, "second commit");
    }

    #[test]
    fn commit_file_diff_scopes_to_single_commit() {
        let (child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("file.txt"), "v1\n").expect("write v1");
        commit_all(&child_path, "add file");
        std::fs::write(child_path.join("file.txt"), "v2\n").expect("write v2");
        commit_all(&child_path, "change file");

        let list = worktree_commits(&child_path, Some("main"), 10).expect("commits");
        let newest = &list.commits[0];
        let diff = commit_file_diff(&child_path, &newest.hash, "file.txt".to_string(), None)
            .expect("diff");
        assert_eq!(diff.old_text, "v1\n");
        assert_eq!(diff.new_text, "v2\n");

        assert!(commit_file_diff(&child_path, "not-a-hash", "file.txt".to_string(), None).is_err());
    }

    #[test]
    fn unstaged_list_includes_working_changes_and_untracked() {
        let (child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("base.txt"), "changed\n").expect("modify base");
        std::fs::write(child_path.join("new.txt"), "new\n").expect("write new");

        let changes = worktree_changes(&child_path, Some("main")).expect("changes");
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
    fn parentless_worktree_has_empty_committed_list() {
        let (_child_path, main_path) = project_with_child();
        let changes = worktree_changes(&main_path, None).expect("changes");
        assert!(changes.committed.is_empty());
    }

    #[test]
    fn parentless_worktree_lists_commits_ahead_of_upstream() {
        let (_remote, local, _peer) = project_with_remote();
        std::fs::write(local.path().join("local.txt"), "local\n").expect("write local");
        commit_all(local.path(), "local commit");

        let changes = worktree_changes(local.path(), None).expect("changes");
        assert!(changes
            .committed
            .iter()
            .any(|change| change.path == "local.txt" && change.status == ChangeStatus::Added));
    }

    #[test]
    fn staged_diff_uses_head_as_old_and_index_as_new() {
        let (child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("base.txt"), "staged\n").expect("modify base");
        run(&child_path, &["add", "base.txt"]);

        let diff = file_diff(
            &child_path,
            "base.txt".to_string(),
            DiffSide::Staged,
            None,
            Some("main"),
        )
        .expect("diff");
        assert_eq!(diff.old_text, "base\n");
        assert_eq!(diff.new_text, "staged\n");
    }

    #[test]
    fn stage_then_unstage_round_trips() {
        let (child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("base.txt"), "changed\n").expect("modify base");

        stage_file(&child_path, "base.txt").expect("stage");
        let changes = worktree_changes(&child_path, Some("main")).expect("changes");
        assert!(changes.staged.iter().any(|c| c.path == "base.txt"));

        unstage_file(&child_path, "base.txt", None).expect("unstage");
        let changes = worktree_changes(&child_path, Some("main")).expect("changes");
        assert!(changes.staged.is_empty());
        assert!(changes.unstaged.iter().any(|c| c.path == "base.txt"));
    }

    #[test]
    fn discard_restores_and_clears() {
        let (child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("base.txt"), "changed\n").expect("modify base");
        std::fs::write(child_path.join("new.txt"), "new\n").expect("write new");

        discard_unstaged_file(&child_path, "base.txt", ChangeStatus::Modified, None)
            .expect("discard modified");
        assert_eq!(
            std::fs::read_to_string(child_path.join("base.txt")).expect("read"),
            "base\n"
        );
        discard_all_unstaged(&child_path).expect("discard all");
        assert!(!child_path.join("new.txt").exists());
    }

    #[test]
    fn commit_rejects_blank_and_creates_commit() {
        let (child_path, _main_path) = project_with_child();
        std::fs::write(child_path.join("feature.txt"), "feature\n").expect("write");
        run(&child_path, &["add", "feature.txt"]);

        assert!(commit_staged(&child_path, "  \n ").is_err());
        commit_staged(&child_path, "add feature").expect("commit");
        let changes = worktree_changes(&child_path, Some("main")).expect("changes");
        assert!(changes.staged.is_empty());
    }

    #[test]
    fn merge_requires_clean_parent_and_fast_forwards() {
        let (child_path, main_path) = project_with_child();
        std::fs::write(child_path.join("feature.txt"), "feature\n").expect("write");
        commit_all(&child_path, "feature commit");

        merge_worktree_to_parent(&main_path, "main", &child_path, "feature").expect("merge");
        assert_eq!(
            std::fs::read_to_string(main_path.join("feature.txt")).expect("read feature"),
            "feature\n"
        );
        assert!(!worktree_is_dirty(&main_path));
    }

    #[test]
    fn merge_reports_conflicts() {
        let (child_path, main_path) = project_with_child();
        std::fs::write(child_path.join("base.txt"), "child\n").expect("write child");
        commit_all(&child_path, "child edits base");
        std::fs::write(main_path.join("base.txt"), "parent\n").expect("write parent");
        commit_all(&main_path, "parent edits base");

        let message = merge_worktree_to_parent(&main_path, "main", &child_path, "feature")
            .expect_err("merge should conflict")
            .to_string();
        assert!(message.contains("Merge conflicts detected"));
    }

    #[test]
    fn remote_status_and_pull_fast_forward() {
        let (_remote, local, peer) = project_with_remote();
        std::fs::write(peer.path().join("remote.txt"), "remote\n").expect("write remote");
        commit_all(peer.path(), "remote commit");
        run(peer.path(), &["push", "origin", "main"]);

        let status = github_fetch_and_sync(local.path()).expect("status");
        assert_eq!(status.behind, 1);
        assert_eq!(status.ahead, 0);
        github_pull_branch(local.path()).expect("pull");
        assert_eq!(
            std::fs::read_to_string(local.path().join("remote.txt")).expect("read remote"),
            "remote\n"
        );
    }

    #[test]
    fn new_branch_without_upstream_is_not_behind_default_branch() {
        let (_remote, local, peer) = project_with_remote();
        run(local.path(), &["checkout", "--no-track", "-b", "feature"]);

        std::fs::write(peer.path().join("remote.txt"), "remote\n").expect("write remote");
        commit_all(peer.path(), "remote commit");
        run(peer.path(), &["push", "origin", "main"]);

        let status = github_fetch_and_sync(local.path()).expect("status");
        assert!(!status.has_upstream);
        assert_eq!(status.behind, 0);
        assert_eq!(status.ahead, 0);
    }

    #[test]
    fn conflicted_pull_aborts_and_preserves_local_commit() {
        let (_remote, local, peer) = project_with_remote();
        std::fs::write(local.path().join("base.txt"), "local\n").expect("write local");
        commit_all(local.path(), "local commit");
        let local_head = stdout(local.path(), &["rev-parse", "HEAD"]);

        std::fs::write(peer.path().join("base.txt"), "remote\n").expect("write remote");
        commit_all(peer.path(), "remote commit");
        run(peer.path(), &["push", "origin", "main"]);

        let message = github_pull_branch(local.path())
            .expect_err("pull should conflict")
            .to_string();
        assert!(message.contains("Pull was aborted"));
        assert_eq!(stdout(local.path(), &["rev-parse", "HEAD"]), local_head);
        assert_eq!(
            std::fs::read_to_string(local.path().join("base.txt")).expect("read local"),
            "local\n"
        );
        assert!(!worktree_is_dirty(local.path()));
    }

    #[test]
    fn sync_refuses_dirty_files_and_pushes_clean_commits() {
        let (_remote, local, peer) = project_with_remote();
        std::fs::write(local.path().join("draft.txt"), "draft\n").expect("write draft");
        let message = github_sync_branch(local.path())
            .expect_err("dirty sync should fail")
            .to_string();
        assert!(message.contains("no files were changed"));
        assert_eq!(
            std::fs::read_to_string(local.path().join("draft.txt")).expect("read draft"),
            "draft\n"
        );

        commit_all(local.path(), "local commit");
        github_sync_branch(local.path()).expect("sync");
        run(peer.path(), &["fetch", "origin"]);
        assert_eq!(
            stdout(peer.path(), &["rev-parse", "origin/main"]),
            stdout(local.path(), &["rev-parse", "HEAD"])
        );
    }

    #[test]
    fn merge_base_branch_preserves_conflicts_for_resolution() {
        let (remote, local, peer) = project_with_remote();
        run(local.path(), &["checkout", "-b", "feature"]);
        std::fs::write(local.path().join("base.txt"), "feature\n").expect("write feature");
        commit_all(local.path(), "feature edit");
        run(local.path(), &["push", "-u", "origin", "feature"]);

        std::fs::write(peer.path().join("base.txt"), "main\n").expect("write main");
        commit_all(peer.path(), "main edit");
        run(peer.path(), &["push", "origin", "main"]);

        assert!(github_merge_base_branch(
            local.path(),
            "main",
            Some(remote.path().to_string_lossy().as_ref()),
        )
        .expect("merge base"));
        assert!(has_unmerged_paths(local.path()).expect("unmerged paths"));
        assert!(std::fs::read_to_string(local.path().join("base.txt"))
            .expect("read conflict")
            .contains("<<<<<<< HEAD"));
    }

    #[test]
    fn abort_merge_discards_conflict_resolution_changes() {
        let (remote, local, peer) = project_with_remote();
        run(local.path(), &["checkout", "-b", "feature"]);
        std::fs::write(local.path().join("base.txt"), "feature\n").expect("write feature");
        commit_all(local.path(), "feature edit");
        run(local.path(), &["push", "-u", "origin", "feature"]);

        std::fs::write(peer.path().join("base.txt"), "main\n").expect("write main");
        commit_all(peer.path(), "main edit");
        run(peer.path(), &["push", "origin", "main"]);

        assert!(github_merge_base_branch(
            local.path(),
            "main",
            Some(remote.path().to_string_lossy().as_ref()),
        )
        .expect("merge base"));
        assert!(github_merge_in_progress(local.path()).expect("merge status"));
        std::fs::write(local.path().join("base.txt"), "manual resolution\n")
            .expect("write resolution");

        github_abort_merge(local.path()).expect("abort merge");

        assert!(!github_merge_in_progress(local.path()).expect("merge status"));
        assert!(!has_unmerged_paths(local.path()).expect("unmerged paths"));
        assert_eq!(
            std::fs::read_to_string(local.path().join("base.txt")).expect("read feature"),
            "feature\n"
        );
        assert!(!worktree_is_dirty(local.path()));
    }

    #[test]
    fn merged_status_reports_every_item_in_the_batch() {
        let (child_path, main_path) = project_with_child();
        std::fs::write(child_path.join("feature.txt"), "feature\n").expect("write feature");
        commit_all(&child_path, "feature commit");
        run(&main_path, &["merge", "--no-ff", "feature"]);

        let items = vec![
            MergedStatusItem {
                id: "merged-child".to_string(),
                root: child_path.to_string_lossy().into_owned(),
                branch: "feature".to_string(),
                parent_branch: Some("main".to_string()),
            },
            MergedStatusItem {
                id: "missing".to_string(),
                root: "/nonexistent/worktree".to_string(),
                branch: "ghost".to_string(),
                parent_branch: Some("main".to_string()),
            },
        ];
        let merged = merged_status(&items);
        assert_eq!(merged.get("merged-child"), Some(&true));
        assert_eq!(merged.get("missing"), Some(&false));
    }
}
