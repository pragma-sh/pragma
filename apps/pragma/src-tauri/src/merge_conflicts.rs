//! AI merge-conflict resolution for the pull request pane.
//!
//! The decisions are made in the `pragma-ai` sidecar
//! (`packages/ai-helpers/src/merge-conflicts.ts`): one System 1 request per
//! conflicted file, all in flight at once, with low-scoring files verified by
//! the built-in AI. This module owns the git side — gathering each file and the
//! commits that touched it, then writing and staging what comes back — and the
//! follow-up commit that concludes the merge.
//!
//! The project git lock is held only while reading and while writing, never
//! across the model calls, so a slow verification cannot stall every other git
//! operation in the project. A file edited in between is left alone.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;

use crate::ai::{
    ensure_local_ai_worktree, git_output, git_output_bytes, git_output_optional, git_run_owned,
    run_oneshot, run_streaming,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::git::GitLocks;
use crate::hosts::Hosts;
use crate::system1::{configured_endpoint, System1KeyStore};

/// Commit subjects gathered per branch per file.
const COMMITS_PER_SIDE: &str = "20";

/// The pull request whose conflicts are being resolved.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPullRequest {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    head_ref: String,
    base_ref: String,
}

/// One conflicted file as sent to the sidecar.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictFileInput {
    path: String,
    content: Option<String>,
    head_commits: Vec<String>,
    base_commits: Vec<String>,
}

/// What the frontend gets back: every file's outcome (without the resolved
/// text) and whatever is still conflicted afterwards.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeConflictResolution {
    files: Vec<Value>,
    remaining: Vec<String>,
}

/// Paths git still marks as unmerged, sorted.
fn unmerged_paths(cwd: &str) -> AppResult<Vec<String>> {
    let stdout = git_output_bytes(cwd, &["diff", "--name-only", "-z", "--diff-filter=U"])?;
    let mut paths: Vec<String> = stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// The merge base of `HEAD` and `MERGE_HEAD`, or an error when no merge is running.
fn merge_base(cwd: &str) -> AppResult<String> {
    if git_output_optional(cwd, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])?.is_none() {
        return Err(AppError::InvalidInput(
            "No merge is in progress. Sync with the base branch first.".to_string(),
        ));
    }
    Ok(git_output(cwd, &["merge-base", "HEAD", "MERGE_HEAD"])?
        .trim()
        .to_string())
}

/// `<sha> <subject>` for commits in `range` touching `path`, newest first.
fn commits_touching(cwd: &str, range: &str, path: &str) -> Vec<String> {
    git_output(
        cwd,
        &[
            "log",
            "--format=%h %s",
            "-n",
            COMMITS_PER_SIDE,
            range,
            "--",
            path,
        ],
    )
    .map(|log| log.lines().map(str::to_string).collect())
    .unwrap_or_default()
}

/// A file's text, or `None` when it is missing, binary, or not UTF-8.
fn read_text(root: &Path, path: &str) -> Option<String> {
    let absolute = crate::fs::resolve_in_worktree(root, path).ok()?;
    let bytes = std::fs::read(absolute).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Every conflicted file with its content and the commits on each side.
fn gather_conflicts(cwd: &str) -> AppResult<Vec<ConflictFileInput>> {
    let base = merge_base(cwd)?;
    let head_range = format!("{base}..HEAD");
    let base_range = format!("{base}..MERGE_HEAD");
    let root = Path::new(cwd);
    Ok(unmerged_paths(cwd)?
        .into_iter()
        .map(|path| ConflictFileInput {
            content: read_text(root, &path),
            head_commits: commits_touching(cwd, &head_range, &path),
            base_commits: commits_touching(cwd, &base_range, &path),
            path,
        })
        .collect())
}

/// Writes and stages one resolved file, unless it changed since it was read.
/// Returns why it was not written, if it was not.
fn write_resolution(cwd: &str, path: &str, sent: Option<&str>, resolved: &str) -> Option<String> {
    let root = Path::new(cwd);
    if read_text(root, path).as_deref() != sent {
        return Some("The file changed while it was being resolved; left untouched.".to_string());
    }
    let written = crate::fs::resolve_in_worktree(root, path)
        .and_then(|absolute| std::fs::write(absolute, resolved).map_err(AppError::from))
        .and_then(|()| {
            git_run_owned(
                cwd,
                &["add".to_string(), "--".to_string(), path.to_string()],
            )
        });
    written.err().map(|error| error.to_string())
}

/// Applies the sidecar's outcomes to disk, returning them without the file text.
fn apply_outcomes(cwd: &str, sent: &[ConflictFileInput], outcomes: Vec<Value>) -> Vec<Value> {
    outcomes
        .into_iter()
        .map(|mut outcome| {
            let resolved = outcome
                .as_object_mut()
                .and_then(|object| object.remove("content"));
            let path = outcome
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let original = sent
                .iter()
                .find(|file| file.path == path)
                .and_then(|file| file.content.as_deref());
            if let Some(text) = resolved.as_ref().and_then(Value::as_str) {
                if let Some(reason) = write_resolution(cwd, &path, original, text) {
                    return json!({ "path": path, "status": "failed", "reason": reason });
                }
            }
            outcome
        })
        .collect()
}

/// Resolves every conflicted file in the worktree's in-progress merge with
/// System 1, verifying low-scoring files with the built-in AI, then writes and
/// stages each resolution. Progress (`system1`, then `verifying` per file)
/// streams through `on_event`.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects each piece of state as its own argument.
pub async fn ai_resolve_merge_conflicts(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    locks: State<'_, GitLocks>,
    store: State<'_, System1KeyStore>,
    worktree_id: String,
    pull_request: ConflictPullRequest,
    on_event: Channel<Value>,
) -> AppResult<MergeConflictResolution> {
    ensure_local_ai_worktree(&db, &hosts, &worktree_id)?;
    let endpoint = configured_endpoint(&app, &store)?;
    let worktree = db.worktree(&worktree_id)?;
    let lock = locks.lock_for(&worktree.project_id)?;
    let cwd = worktree.path;

    tauri::async_runtime::spawn_blocking(move || {
        let files = {
            let _guard = lock.lock()?;
            gather_conflicts(&cwd)?
        };
        if files.is_empty() {
            return Ok(MergeConflictResolution {
                files: Vec::new(),
                remaining: Vec::new(),
            });
        }
        let request = json!({
            "endpoint": endpoint,
            "pullRequest": pull_request,
            "files": files,
        });
        let value = run_streaming(
            &["resolve-conflicts", "--cwd", &cwd],
            Some(&request.to_string()),
            |event| {
                let _ = on_event.send(event.clone());
            },
        )?;
        let outcomes = value
            .get("files")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| AppError::Ai("resolve-conflicts returned no files".to_string()))?;

        let _guard = lock.lock()?;
        let files = apply_outcomes(&cwd, &files, outcomes);
        Ok(MergeConflictResolution {
            files,
            remaining: unmerged_paths(&cwd)?,
        })
    })
    .await
    .map_err(|error| AppError::Ai(format!("merge conflict task failed: {error}")))?
}

/// Files both branches changed since the merge base — the ones the merge had
/// to reconcile, and so the ones the commit message should describe.
fn files_changed_on_both_sides(cwd: &str, base: &str) -> AppResult<Vec<String>> {
    let ours: HashSet<String> = git_output(cwd, &["diff", "--name-only", base, "HEAD"])?
        .lines()
        .map(str::to_string)
        .collect();
    let mut both: Vec<String> = git_output(cwd, &["diff", "--name-only", base, "MERGE_HEAD"])?
        .lines()
        .filter(|path| ours.contains(*path))
        .map(str::to_string)
        .collect();
    both.sort();
    Ok(both)
}

/// The note that tells the commit-message model this is a conflict resolution.
fn merge_note(base_ref: &str, head_ref: &str, files: &[String]) -> String {
    let listed = if files.is_empty() {
        String::new()
    } else {
        format!(
            " They resolve merge conflicts in: {}. The diff below is limited to those files.",
            files.join(", ")
        )
    };
    format!(
        "These staged changes conclude merging the base branch `{base_ref}` into the pull \
         request branch `{head_ref}`.{listed} Describe the commit as fixing the merge \
         conflicts with `{base_ref}`, not as the base branch's own changes."
    )
}

/// Commits the resolved merge with an AI-written message that says it fixes
/// merge conflicts, returning the message. Refuses while any file is still
/// conflicted. Pushing is left to `github_push_branch`.
#[tauri::command]
pub async fn ai_commit_merge_resolution(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    locks: State<'_, GitLocks>,
    worktree_id: String,
    base_ref: String,
    head_ref: String,
) -> AppResult<String> {
    ensure_local_ai_worktree(&db, &hosts, &worktree_id)?;
    let worktree = db.worktree(&worktree_id)?;
    let lock = locks.lock_for(&worktree.project_id)?;
    let cwd = worktree.path;

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock()?;
        let base = merge_base(&cwd)?;
        let remaining = unmerged_paths(&cwd)?;
        if !remaining.is_empty() {
            return Err(AppError::InvalidInput(format!(
                "Resolve the remaining conflicts first: {}",
                remaining.join(", ")
            )));
        }
        let files = files_changed_on_both_sides(&cwd, &base)?;
        let mut args = vec!["diff".to_string(), "--cached".to_string()];
        if !files.is_empty() {
            args.push("--".to_string());
            args.extend(files.iter().cloned());
        }
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let diff = git_output(&cwd, &args)?;

        let message = if diff.trim().is_empty() {
            // Every conflict resolved back to the branch's own text: nothing
            // for a model to describe, but the merge still needs its commit.
            format!("Merge branch '{base_ref}' into {head_ref}")
        } else {
            let note = merge_note(&base_ref, &head_ref, &files);
            let value = run_oneshot(
                &["commit-message", "--cwd", &cwd, "--note", &note],
                Some(&diff),
            )?;
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| AppError::Ai("ai sidecar returned no message".to_string()))?
        };
        git_run_owned(
            &cwd,
            &["commit".to_string(), "-m".to_string(), message.clone()],
        )?;
        Ok(message)
    })
    .await
    .map_err(|error| AppError::Ai(format!("merge commit task failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command;

    use super::{apply_outcomes, files_changed_on_both_sides, gather_conflicts, merge_base};
    use serde_json::json;

    fn run(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    /// A repo mid-merge: `feature` and `main` both edited `a.txt`.
    fn conflicted_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        run(root, &["init", "-b", "main"]);
        run(root, &["config", "user.email", "t@example.com"]);
        run(root, &["config", "user.name", "T"]);
        run(root, &["config", "core.autocrlf", "false"]);
        run(root, &["config", "core.eol", "lf"]);
        std::fs::write(root.join("a.txt"), "base\n").expect("write");
        run(root, &["add", "."]);
        run(root, &["commit", "-m", "base"]);
        run(root, &["checkout", "-b", "feature"]);
        std::fs::write(root.join("a.txt"), "feature\n").expect("write");
        run(root, &["commit", "-am", "feat: feature edit"]);
        run(root, &["checkout", "main"]);
        std::fs::write(root.join("a.txt"), "main\n").expect("write");
        run(root, &["commit", "-am", "fix: main edit"]);
        run(root, &["checkout", "feature"]);
        let merged = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["merge", "main"])
            .output()
            .expect("merge");
        assert!(!merged.status.success(), "merge should conflict");
        dir
    }

    #[test]
    fn gathers_conflicts_with_commits_from_each_side() {
        let dir = conflicted_repo();
        let cwd = dir.path().to_string_lossy().to_string();
        let files = gather_conflicts(&cwd).expect("gather");
        assert_eq!(files.len(), 1);
        let file = &files[0];
        assert_eq!(file.path, "a.txt");
        assert!(file.content.as_deref().unwrap_or("").contains("<<<<<<<"));
        assert!(file.head_commits[0].ends_with("feat: feature edit"));
        assert!(file.base_commits[0].ends_with("fix: main edit"));
        let base = merge_base(&cwd).expect("merge base");
        assert_eq!(
            files_changed_on_both_sides(&cwd, &base).expect("both"),
            vec!["a.txt"]
        );
    }

    #[test]
    fn applies_resolution_and_stages_it_unless_the_file_changed() {
        let dir = conflicted_repo();
        let cwd = dir.path().to_string_lossy().to_string();
        let files = gather_conflicts(&cwd).expect("gather");
        let outcome = json!({ "path": "a.txt", "status": "resolved", "content": "merged\n" });

        std::fs::write(dir.path().join("a.txt"), "edited meanwhile\n").expect("write");
        let skipped = apply_outcomes(&cwd, &files, vec![outcome.clone()]);
        assert_eq!(skipped[0]["status"], "failed");

        let files = gather_conflicts(&cwd).expect("gather again");
        let applied = apply_outcomes(&cwd, &files, vec![outcome]);
        assert_eq!(applied[0]["status"], "resolved");
        assert!(applied[0].get("content").is_none());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).expect("read"),
            "merged\n"
        );
        assert!(super::unmerged_paths(&cwd).expect("unmerged").is_empty());
    }

    #[test]
    fn merge_base_requires_a_merge_in_progress() {
        let dir = tempfile::tempdir().expect("tempdir");
        run(dir.path(), &["init"]);
        assert!(merge_base(&dir.path().to_string_lossy()).is_err());
    }
}
