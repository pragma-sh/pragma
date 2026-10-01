//! AI merge-conflict resolution for the pull request pane.
//!
//! The decisions are made in the `pragma-ai` sidecar
//! (`packages/ai-helpers/src/merge-conflicts.ts`): one System 1 request per
//! conflicted file, all in flight at once, with low-scoring files verified by
//! the built-in AI. All git work — reading each conflicted file, writing and
//! staging what comes back, and the follow-up commit that concludes the merge —
//! runs on the worktree's owning host through `pragma-core`'s `git` RPC
//! (`pragma_core::merge_conflicts`). Only the model calls stay here.
//!
//! The project git lock is held only around those RPCs, never across a model
//! call, so a slow verification or commit-message request cannot stall every
//! other git operation in the project. The host re-checks the merge's identity
//! and the conflicted index entries (or, for the commit, the staged tree) on
//! the way back in, so a merge that was aborted and restarted meanwhile is
//! left alone.

use std::collections::HashMap;

use pragma_core::git::GitRequest;
use pragma_core::merge_conflicts::{
    ConflictFile, MergeCommitContext, MergeConflictInputs, ResolutionResult, ResolutionWrite,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;

use crate::ai::{ensure_local_ai_worktree, run_oneshot, run_streaming};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::git::{host_rpc, GitLocks};
use crate::hosts::Hosts;
use crate::system1::{configured_endpoint, System1KeyStore};

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

/// What the frontend gets back: every file's outcome (without the resolved
/// text) and whatever is still conflicted afterwards.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeConflictResolution {
    files: Vec<Value>,
    remaining: Vec<String>,
}

/// One conflicted file as the sidecar takes it (the index entries stay here).
fn sidecar_file(file: &ConflictFile) -> Value {
    json!({
        "path": file.path,
        "content": file.content,
        "headCommits": file.head_commits,
        "baseCommits": file.base_commits,
    })
}

/// Outcome for a file that was not written.
fn failed(path: &str, reason: &str) -> Value {
    json!({ "path": path, "status": "failed", "reason": reason })
}

/// Splits the sidecar's outcomes into writes for the host and outcomes that
/// need no write, each without the resolved text. `writes[i]` belongs to
/// `outcomes[slots[i]]`.
fn plan_writes(
    sent: &[ConflictFile],
    outcomes: Vec<Value>,
) -> (Vec<Value>, Vec<ResolutionWrite>, Vec<usize>) {
    let by_path: HashMap<&str, &ConflictFile> =
        sent.iter().map(|file| (file.path.as_str(), file)).collect();
    let mut kept = Vec::with_capacity(outcomes.len());
    let mut writes = Vec::new();
    let mut slots = Vec::new();
    for mut outcome in outcomes {
        let resolved = outcome
            .as_object_mut()
            .and_then(|object| object.remove("content"));
        let path = outcome
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if let Some(text) = resolved.as_ref().and_then(Value::as_str) {
            match by_path.get(path.as_str()) {
                Some(file) => {
                    slots.push(kept.len());
                    writes.push(ResolutionWrite {
                        path,
                        sent: file.content.clone(),
                        index: file.index.clone(),
                        content: text.to_string(),
                    });
                }
                None => outcome = failed(&path, "Not a conflicted file of this merge."),
            }
        }
        kept.push(outcome);
    }
    (kept, writes, slots)
}

/// Replaces the outcome of every write the host refused with a failure.
fn apply_results(
    mut outcomes: Vec<Value>,
    slots: &[usize],
    results: &[ResolutionResult],
) -> Vec<Value> {
    for (slot, result) in slots.iter().zip(results) {
        if let (Some(reason), Some(outcome)) = (&result.error, outcomes.get_mut(*slot)) {
            *outcome = failed(&result.path, reason);
        }
    }
    outcomes
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
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    let lock = locks.lock_for(&worktree.project_id)?;
    let cwd = worktree.path;

    tauri::async_runtime::spawn_blocking(move || {
        let inputs: MergeConflictInputs = {
            let _guard = lock.lock()?;
            host_rpc(&pty, &GitRequest::MergeConflictInputs { root: cwd.clone() })?
        };
        if inputs.files.is_empty() {
            return Ok(MergeConflictResolution {
                files: Vec::new(),
                remaining: Vec::new(),
            });
        }
        let request = json!({
            "endpoint": endpoint,
            "pullRequest": pull_request,
            "files": inputs.files.iter().map(sidecar_file).collect::<Vec<_>>(),
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

        let (outcomes, writes, slots) = plan_writes(&inputs.files, outcomes);
        let _guard = lock.lock()?;
        let results: Vec<ResolutionResult> = host_rpc(
            &pty,
            &GitRequest::ApplyMergeResolutions {
                root: cwd.clone(),
                identity: inputs.identity,
                resolutions: writes,
            },
        )?;
        let remaining: Vec<String> =
            host_rpc(&pty, &GitRequest::GithubUnmergedPaths { root: cwd })?;
        Ok(MergeConflictResolution {
            files: apply_results(outcomes, &slots, &results),
            remaining,
        })
    })
    .await
    .map_err(|error| AppError::Ai(format!("merge conflict task failed: {error}")))?
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

/// The commit message for a resolved merge: the model's, or the plain merge
/// message when every conflict resolved back to the branch's own text.
fn merge_message(
    cwd: &str,
    context: &MergeCommitContext,
    base_ref: &str,
    head_ref: &str,
) -> AppResult<String> {
    if context.diff.trim().is_empty() {
        // Nothing for a model to describe, but the merge still needs its commit.
        return Ok(format!("Merge branch '{base_ref}' into {head_ref}"));
    }
    let note = merge_note(base_ref, head_ref, &context.files);
    let value = run_oneshot(
        &["commit-message", "--cwd", cwd, "--note", &note],
        Some(&context.diff),
    )?;
    value
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::Ai("ai sidecar returned no message".to_string()))
}

/// Commits the resolved merge with an AI-written message that says it fixes
/// merge conflicts, returning the message. Refuses while any file is still
/// conflicted, and when the merge or staged changes move while the message is
/// being written. Pushing is left to `github_push_branch`.
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
    let pty = hosts.for_worktree(&db, &worktree_id)?;
    let lock = locks.lock_for(&worktree.project_id)?;
    let cwd = worktree.path;

    tauri::async_runtime::spawn_blocking(move || {
        let context: MergeCommitContext = {
            let _guard = lock.lock()?;
            host_rpc(&pty, &GitRequest::MergeCommitContext { root: cwd.clone() })?
        };
        // The lock is free while the model writes the message; the host
        // re-validates the merge and index when the commit comes back.
        let message = merge_message(&cwd, &context, &base_ref, &head_ref)?;
        let _guard = lock.lock()?;
        host_rpc::<()>(
            &pty,
            &GitRequest::CommitMerge {
                root: cwd,
                identity: context.identity,
                tree: context.tree,
                message: message.clone(),
            },
        )?;
        Ok(message)
    })
    .await
    .map_err(|error| AppError::Ai(format!("merge commit task failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use pragma_core::merge_conflicts::{ConflictFile, ResolutionResult};
    use serde_json::json;

    use super::{apply_results, merge_note, plan_writes};

    fn file(path: &str) -> ConflictFile {
        ConflictFile {
            path: path.to_string(),
            content: Some("<<<<<<< HEAD\n".to_string()),
            head_commits: Vec::new(),
            base_commits: Vec::new(),
            index: "100644 abc 1".to_string(),
        }
    }

    #[test]
    fn plans_a_write_per_resolved_file_and_strips_the_text() {
        let sent = vec![file("a.txt"), file("b.txt")];
        let outcomes = vec![
            json!({ "path": "a.txt", "status": "resolved", "content": "merged\n" }),
            json!({ "path": "b.txt", "status": "failed", "reason": "low confidence" }),
            json!({ "path": "c.txt", "status": "resolved", "content": "x" }),
        ];
        let (kept, writes, slots) = plan_writes(&sent, outcomes);
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].path, "a.txt");
        assert_eq!(writes[0].index, "100644 abc 1");
        assert_eq!(slots, vec![0]);
        assert!(kept[0].get("content").is_none());
        assert_eq!(kept[2]["status"], "failed");
    }

    #[test]
    fn a_refused_write_becomes_a_failed_outcome() {
        let outcomes = vec![json!({ "path": "a.txt", "status": "resolved" })];
        let results = vec![ResolutionResult {
            path: "a.txt".to_string(),
            error: Some("The merge changed".to_string()),
        }];
        let applied = apply_results(outcomes, &[0], &results);
        assert_eq!(applied[0]["status"], "failed");
        assert_eq!(applied[0]["reason"], "The merge changed");
    }

    #[test]
    fn note_names_both_branches_and_the_files() {
        let note = merge_note("main", "feature", &["a.txt".to_string()]);
        assert!(note.contains("`main`") && note.contains("`feature`") && note.contains("a.txt"));
    }
}
