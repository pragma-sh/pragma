//! The rules around an AI-assisted commit: what the model is shown, what it is
//! allowed to touch, and how its plan becomes commits.
//!
//! These live in the host boundary because both the desktop and `pragma-server`
//! run them — the desktop from its sidebar, the server when a phone asks with no
//! desktop window open. The model's output is *checked* here, not trusted: a
//! plan that names a path outside the changed set is rejected rather than
//! staged, and paths the plan forgot are still committed rather than silently
//! left behind.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::git;
use crate::{CoreError, CoreResult};

/// What the model is shown when planning commits.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPlanContext {
    /// Every path the plan may touch. The model gets no say in this list.
    pub allowed_paths: Vec<String>,
    pub status: String,
    pub diff_stat: String,
    pub worktree_diff: String,
}

/// What the model is shown when drafting a pull request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestContext {
    pub git_log: String,
    pub diff_stat: String,
    pub committed_diff: String,
}

/// One commit the model proposed.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct CommitPlanCommit {
    pub message: String,
    pub paths: Vec<String>,
}

/// The model's proposed commits, before checking.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CommitPlan {
    pub commits: Vec<CommitPlanCommit>,
}

/// Every path with uncommitted work: tracked changes plus untracked files.
///
/// Untracked files are included because "commit all my changes" means all of
/// them; a new file left behind is the one the build then fails without.
pub fn changed_paths(root: &Path) -> CoreResult<Vec<String>> {
    let mut paths = Vec::new();
    for args in [
        ["diff", "--name-only", "-z", "HEAD"].as_slice(),
        ["ls-files", "--others", "--exclude-standard", "-z"].as_slice(),
    ] {
        for path in git::stdout_bytes_in(root, args)?
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
        {
            let path = String::from_utf8_lossy(path).into_owned();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    Ok(paths)
}

/// Builds the planning context for a worktree's uncommitted changes.
pub fn commit_plan_context(root: &Path) -> CoreResult<CommitPlanContext> {
    Ok(CommitPlanContext {
        allowed_paths: changed_paths(root)?,
        status: git::stdout_optional_in(root, &["status", "--short", "--untracked-files=normal"])
            .unwrap_or_default(),
        diff_stat: git::stdout_optional_in(root, &["diff", "--stat", "--find-renames", "HEAD"])
            .unwrap_or_default(),
        worktree_diff: git::stdout_optional_in(root, &["diff", "--find-renames", "HEAD"])
            .unwrap_or_default(),
    })
}

/// Checks a model's plan against the paths it was allowed to touch.
///
/// Two rules, both about not losing work: a path outside the changed set is a
/// refusal, because staging it would commit something the user never put in
/// front of the model; and a changed path the plan omitted is appended to the
/// last commit, because "commit everything" that quietly skips a file is worse
/// than an imperfect grouping.
pub fn normalize_commit_plan(
    plan: CommitPlan,
    allowed_paths: &[String],
) -> CoreResult<Vec<CommitPlanCommit>> {
    let allowed: HashSet<&str> = allowed_paths.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    let mut commits = Vec::new();

    for commit in plan.commits {
        let message = commit.message.trim().to_string();
        if message.is_empty() {
            return Err(CoreError::Operation(
                "the model returned a commit with no message".to_string(),
            ));
        }
        let mut paths = Vec::new();
        for path in commit.paths {
            let path = path.trim().to_string();
            if !allowed.contains(path.as_str()) {
                return Err(CoreError::Operation(format!(
                    "the model returned a path outside the changed set: {path}"
                )));
            }
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
        if !paths.is_empty() {
            commits.push(CommitPlanCommit { message, paths });
        }
    }

    let missing: Vec<String> = allowed_paths
        .iter()
        .filter(|path| !seen.contains(path.as_str()))
        .cloned()
        .collect();
    if !missing.is_empty() {
        let Some(last) = commits.last_mut() else {
            return Err(CoreError::Operation(
                "the model returned no usable commit plan".to_string(),
            ));
        };
        last.paths.extend(missing);
    }

    if commits.is_empty() {
        return Err(CoreError::Operation(
            "the model returned no usable commit plan".to_string(),
        ));
    }
    Ok(commits)
}

/// Applies a checked plan, returning how many commits it actually made.
///
/// The index is emptied before and after each commit, so a partially staged
/// worktree the user left behind cannot leak into an AI-planned commit. A
/// commit whose paths turn out to stage nothing is skipped rather than made
/// empty. Anything still uncommitted at the end is an error: this operation
/// promised to commit everything.
pub fn apply_commit_plan(root: &Path, commits: &[CommitPlanCommit]) -> CoreResult<usize> {
    unstage_all(root)?;
    let mut made = 0;
    for commit in commits {
        for path in &commit.paths {
            git::stdout_bytes_in(root, &["add", "--", path])?;
        }
        if git::stdout_in(root, &["diff", "--cached"])?
            .trim()
            .is_empty()
        {
            continue;
        }
        git::stdout_bytes_in(root, &["commit", "--no-verify", "-m", &commit.message])?;
        made += 1;
        unstage_all(root)?;
    }
    let remaining = changed_paths(root)?;
    if !remaining.is_empty() {
        return Err(CoreError::Operation(format!(
            "failed to commit all changes; still uncommitted: {}",
            remaining.join(", ")
        )));
    }
    Ok(made)
}

fn unstage_all(root: &Path) -> CoreResult<()> {
    // `reset` rather than `reset --hard`: this empties the index and touches no
    // file in the working tree.
    git::stdout_bytes_in(root, &["reset"]).map(|_| ())
}

/// Builds the pull-request drafting context for the branch's own commits.
pub fn pull_request_context(
    root: &Path,
    parent_branch: &str,
    parent_path: Option<&Path>,
) -> CoreResult<PullRequestContext> {
    let merge_base = merge_base(root, parent_branch, parent_path)?;
    let range = format!("{merge_base}..HEAD");
    Ok(PullRequestContext {
        git_log: git::stdout_in(root, &["log", "--reverse", "--format=%h %s%n%b", &range])?,
        diff_stat: git::stdout_in(
            root,
            &["diff", "--stat", "--find-renames", &merge_base, "HEAD"],
        )?,
        committed_diff: git::stdout_in(root, &["diff", "--find-renames", &merge_base, "HEAD"])?,
    })
}

/// Finds where this branch left its parent.
///
/// The parent branch may exist here as a local ref, as a remote-tracking ref,
/// or only as whatever the parent worktree currently has checked out — a
/// worktree branch that was never pushed is the common case. Each candidate is
/// tried in turn rather than assuming one shape.
fn merge_base(root: &Path, parent_branch: &str, parent_path: Option<&Path>) -> CoreResult<String> {
    for candidate in base_ref_candidates(parent_branch, parent_path) {
        let Some(base) = git::stdout_optional_in(root, &["merge-base", "HEAD", &candidate]) else {
            continue;
        };
        let base = base.trim().to_string();
        if !base.is_empty() {
            return Ok(base);
        }
    }
    Err(CoreError::Operation(format!(
        "unable to determine where this branch diverged from {parent_branch}"
    )))
}

/// The refs that might name the parent branch, in the order worth trying.
#[must_use]
pub fn base_ref_candidates(parent_branch: &str, parent_path: Option<&Path>) -> Vec<String> {
    let mut candidates = Vec::new();
    for candidate in [
        parent_branch.to_string(),
        format!("refs/heads/{parent_branch}"),
        format!("origin/{parent_branch}"),
        format!("refs/remotes/origin/{parent_branch}"),
    ] {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    if let Some(path) = parent_path {
        if let Some(head) = git::stdout_optional_in(path, &["rev-parse", "HEAD"]) {
            let head = head.trim().to_string();
            if !head.is_empty() && !candidates.contains(&head) {
                candidates.push(head);
            }
        }
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::{base_ref_candidates, normalize_commit_plan, CommitPlan, CommitPlanCommit};

    fn plan(commits: Vec<(&str, Vec<&str>)>) -> CommitPlan {
        CommitPlan {
            commits: commits
                .into_iter()
                .map(|(message, paths)| CommitPlanCommit {
                    message: message.to_string(),
                    paths: paths.into_iter().map(str::to_string).collect(),
                })
                .collect(),
        }
    }

    fn allowed(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|path| (*path).to_string()).collect()
    }

    #[test]
    fn keeps_the_models_grouping_when_it_covers_everything() {
        let commits = normalize_commit_plan(
            plan(vec![("feat: a", vec!["a.rs"]), ("fix: b", vec!["b.rs"])]),
            &allowed(&["a.rs", "b.rs"]),
        )
        .expect("a covering plan is used as given");

        assert_eq!(commits.len(), 2);
        assert_eq!(commits[1].paths, ["b.rs"]);
    }

    #[test]
    fn refuses_a_path_the_user_never_put_in_front_of_the_model() {
        let error = normalize_commit_plan(
            plan(vec![("feat: a", vec!["a.rs", "~/.ssh/id_rsa"])]),
            &allowed(&["a.rs"]),
        )
        .expect_err("a path outside the changed set is a refusal");

        assert!(error.to_string().contains("outside the changed set"));
    }

    #[test]
    fn commits_a_changed_path_the_plan_forgot() {
        // Quietly skipping a file is worse than an imperfect grouping: the user
        // asked for everything to be committed.
        let commits = normalize_commit_plan(
            plan(vec![("feat: a", vec!["a.rs"])]),
            &allowed(&["a.rs", "forgotten.rs"]),
        )
        .expect("a partial plan still commits everything");

        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].paths, ["a.rs", "forgotten.rs"]);
    }

    #[test]
    fn drops_a_duplicate_path_rather_than_staging_it_twice() {
        let commits = normalize_commit_plan(
            plan(vec![
                ("feat: a", vec!["a.rs"]),
                ("fix: a again", vec!["a.rs"]),
            ]),
            &allowed(&["a.rs"]),
        )
        .expect("a duplicate is dropped, not an error");

        assert_eq!(commits.len(), 1);
    }

    #[test]
    fn rejects_a_commit_with_no_message() {
        assert!(
            normalize_commit_plan(plan(vec![("   ", vec!["a.rs"])]), &allowed(&["a.rs"])).is_err()
        );
    }

    #[test]
    fn rejects_a_plan_with_nothing_usable_in_it() {
        assert!(normalize_commit_plan(plan(vec![]), &allowed(&["a.rs"])).is_err());
    }

    #[test]
    fn tries_local_then_remote_forms_of_the_parent_branch() {
        let candidates = base_ref_candidates("main", None);

        assert_eq!(
            candidates,
            [
                "main",
                "refs/heads/main",
                "origin/main",
                "refs/remotes/origin/main"
            ]
        );
    }
}
