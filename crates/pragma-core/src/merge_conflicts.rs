//! Host-side git work for AI merge-conflict resolution.
//!
//! The decisions are made elsewhere (the `pragma-ai` sidecar); this module only
//! touches the repository. Each step is one `git` RPC so a remote worktree is
//! read and written on the host that owns it:
//!
//! 1. [`conflict_inputs`] reads every conflicted file, the commits that touched
//!    it on each side, and the merge's identity.
//! 2. [`apply_resolutions`] writes and stages results — but only into the merge
//!    they were decided for, and only for files whose text and conflicted index
//!    entries are unchanged since they were read.
//! 3. [`merge_commit_context`] and [`commit_merge`] conclude the merge, again
//!    refusing a merge or index that moved between the two calls.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::git::{git_stdout, run_git};
use crate::{fs, CoreError, CoreResult};

/// Commit subjects gathered per branch per file.
const COMMITS_PER_SIDE: &str = "20";

/// Which merge a decision belongs to: the commits on both sides of it. An
/// aborted and restarted merge (even with identical file text) has a
/// different `merge_head` or `head`, so stale decisions cannot be applied to it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeIdentity {
    /// `HEAD` — the branch being merged into.
    pub head: String,
    /// `MERGE_HEAD` — the branch being merged in.
    pub merge_head: String,
}

/// One conflicted file as read from the worktree.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    /// Worktree-relative path.
    pub path: String,
    /// The file's text, or `None` when it is missing, binary, or not UTF-8.
    pub content: Option<String>,
    /// `<sha> <subject>` for `HEAD`-side commits touching the file.
    pub head_commits: Vec<String>,
    /// `<sha> <subject>` for `MERGE_HEAD`-side commits touching the file.
    pub base_commits: Vec<String>,
    /// The file's unmerged index entries, compared again before writing.
    pub index: String,
}

/// Every conflicted file plus the merge they belong to.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeConflictInputs {
    /// The merge these files were read from.
    pub identity: MergeIdentity,
    /// Conflicted files, sorted by path.
    pub files: Vec<ConflictFile>,
}

/// One resolution to write, with what the file looked like when it was read.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionWrite {
    /// Worktree-relative path.
    pub path: String,
    /// The text the decision was made against.
    pub sent: Option<String>,
    /// The unmerged index entries the decision was made against.
    pub index: String,
    /// The resolved text to write.
    pub content: String,
}

/// Why one resolution was not written; `error` is `None` when it was.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionResult {
    /// Worktree-relative path.
    pub path: String,
    /// The reason the file was left untouched, if it was.
    pub error: Option<String>,
}

/// What a commit message is written from, and the state it was read at.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeCommitContext {
    /// The merge being concluded.
    pub identity: MergeIdentity,
    /// The index tree the diff was read from; the commit requires it unchanged.
    pub tree: String,
    /// Files both branches changed since the merge base.
    pub files: Vec<String>,
    /// The staged diff, limited to `files` when there are any.
    pub diff: String,
}

/// `HEAD` and `MERGE_HEAD`, or an error when no merge is running.
pub(crate) fn merge_identity(root: &Path) -> CoreResult<MergeIdentity> {
    let Ok(merge_head) = git_stdout(root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]) else {
        return Err(CoreError::Operation(
            "No merge is in progress. Sync with the base branch first.".to_string(),
        ));
    };
    Ok(MergeIdentity {
        head: git_stdout(root, &["rev-parse", "HEAD"])?,
        merge_head,
    })
}

/// Unmerged index entries grouped by path: `<mode> <oid> <stage>` per entry.
fn unmerged_entries(root: &Path) -> CoreResult<BTreeMap<String, String>> {
    let stdout = run_git(root, &["ls-files", "-u", "-z"])?;
    let mut entries: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for record in stdout.split(|byte| *byte == 0).filter(|r| !r.is_empty()) {
        let record = String::from_utf8_lossy(record);
        if let Some((meta, path)) = record.split_once('\t') {
            entries
                .entry(path.to_string())
                .or_default()
                .push(meta.to_string());
        }
    }
    Ok(entries
        .into_iter()
        .map(|(path, metas)| (path, metas.join(";")))
        .collect())
}

/// `<sha> <subject>` for commits in `range` touching `path`, newest first.
fn commits_touching(root: &Path, range: &str, path: &str) -> Vec<String> {
    run_git(
        root,
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
    .map(|log| {
        String::from_utf8_lossy(&log)
            .lines()
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

/// A file's text, or `None` when it is missing, binary, or not UTF-8.
fn read_text(root: &Path, path: &str) -> Option<String> {
    let absolute = fs::resolve_in_worktree(root, path).ok()?;
    let bytes = std::fs::read(absolute).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Every conflicted file with its content and the commits on each side.
pub(crate) fn conflict_inputs(root: &Path) -> CoreResult<MergeConflictInputs> {
    let identity = merge_identity(root)?;
    let base = git_stdout(root, &["merge-base", "HEAD", "MERGE_HEAD"])?;
    let head_range = format!("{base}..HEAD");
    let base_range = format!("{base}..MERGE_HEAD");
    let files = unmerged_entries(root)?
        .into_iter()
        .map(|(path, index)| ConflictFile {
            content: read_text(root, &path),
            head_commits: commits_touching(root, &head_range, &path),
            base_commits: commits_touching(root, &base_range, &path),
            path,
            index,
        })
        .collect();
    Ok(MergeConflictInputs { identity, files })
}

/// Writes and stages one resolution, unless the file moved since it was read.
/// Returns why it was not written, if it was not.
fn write_resolution(
    root: &Path,
    current: &BTreeMap<String, String>,
    write: &ResolutionWrite,
) -> Option<String> {
    if current.get(&write.path) != Some(&write.index) {
        return Some("The conflict changed while it was being resolved; left untouched.".into());
    }
    if read_text(root, &write.path) != write.sent {
        return Some("The file changed while it was being resolved; left untouched.".into());
    }
    let written = fs::resolve_in_worktree(root, &write.path)
        .and_then(|absolute| std::fs::write(absolute, &write.content).map_err(CoreError::from))
        .and_then(|()| run_git(root, &["add", "--", &write.path]).map(|_| ()));
    written.err().map(|error| error.to_string())
}

/// Writes and stages each resolution into the merge it was decided for.
/// Nothing is written when the merge is no longer the one in `identity`.
pub(crate) fn apply_resolutions(
    root: &Path,
    identity: &MergeIdentity,
    writes: &[ResolutionWrite],
) -> CoreResult<Vec<ResolutionResult>> {
    let merge_moved = merge_identity(root).ok().as_ref() != Some(identity);
    let current = if merge_moved {
        BTreeMap::new()
    } else {
        unmerged_entries(root)?
    };
    Ok(writes
        .iter()
        .map(|write| ResolutionResult {
            path: write.path.clone(),
            error: if merge_moved {
                Some("The merge changed while it was being resolved; left untouched.".into())
            } else {
                write_resolution(root, &current, write)
            },
        })
        .collect())
}

/// Files both branches changed since the merge base — the ones the merge had
/// to reconcile, and so the ones the commit message should describe.
fn files_changed_on_both_sides(root: &Path, base: &str) -> CoreResult<Vec<String>> {
    let names = |target: &str| -> CoreResult<Vec<String>> {
        Ok(
            String::from_utf8_lossy(&run_git(root, &["diff", "--name-only", base, target])?)
                .lines()
                .map(str::to_string)
                .collect(),
        )
    };
    let ours: HashSet<String> = names("HEAD")?.into_iter().collect();
    let mut both: Vec<String> = names("MERGE_HEAD")?
        .into_iter()
        .filter(|path| ours.contains(path))
        .collect();
    both.sort();
    Ok(both)
}

/// Reads what the merge commit message is written from. Refuses while any file
/// is still conflicted.
pub(crate) fn merge_commit_context(root: &Path) -> CoreResult<MergeCommitContext> {
    let identity = merge_identity(root)?;
    let remaining: Vec<String> = unmerged_entries(root)?.into_keys().collect();
    if !remaining.is_empty() {
        return Err(CoreError::Operation(format!(
            "Resolve the remaining conflicts first: {}",
            remaining.join(", ")
        )));
    }
    let base = git_stdout(root, &["merge-base", "HEAD", "MERGE_HEAD"])?;
    let files = files_changed_on_both_sides(root, &base)?;
    let mut args = vec!["diff", "--cached"];
    if !files.is_empty() {
        args.push("--");
        args.extend(files.iter().map(String::as_str));
    }
    let diff = String::from_utf8_lossy(&run_git(root, &args)?).into_owned();
    Ok(MergeCommitContext {
        identity,
        tree: git_stdout(root, &["write-tree"])?,
        files,
        diff,
    })
}

/// Commits the merge with `message`, provided it is still the merge — and the
/// index still the tree — that `message` was written for.
pub(crate) fn commit_merge(
    root: &Path,
    identity: &MergeIdentity,
    tree: &str,
    message: &str,
) -> CoreResult<()> {
    if &merge_identity(root)? != identity {
        return Err(CoreError::Operation(
            "The merge changed while the commit message was being written.".to_string(),
        ));
    }
    if !unmerged_entries(root)?.is_empty() || git_stdout(root, &["write-tree"])? != tree {
        return Err(CoreError::Operation(
            "The staged changes changed while the commit message was being written.".to_string(),
        ));
    }
    run_git(root, &["commit", "-m", message]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command;

    use super::{
        apply_resolutions, commit_merge, conflict_inputs, merge_commit_context, merge_identity,
        ResolutionWrite,
    };

    fn run(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    fn start_merge(root: &Path) {
        run(root, &["checkout", "feature"]);
        let merged = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["merge", "main"])
            .output()
            .expect("merge");
        assert!(!merged.status.success(), "merge should conflict");
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
        start_merge(root);
        dir
    }

    fn write_for(inputs: &super::MergeConflictInputs, content: &str) -> ResolutionWrite {
        let file = &inputs.files[0];
        ResolutionWrite {
            path: file.path.clone(),
            sent: file.content.clone(),
            index: file.index.clone(),
            content: content.to_string(),
        }
    }

    #[test]
    fn gathers_conflicts_with_commits_from_each_side() {
        let dir = conflicted_repo();
        let inputs = conflict_inputs(dir.path()).expect("gather");
        assert_eq!(inputs.files.len(), 1);
        let file = &inputs.files[0];
        assert_eq!(file.path, "a.txt");
        assert!(file.content.as_deref().unwrap_or("").contains("<<<<<<<"));
        assert!(file.head_commits[0].ends_with("feat: feature edit"));
        assert!(file.base_commits[0].ends_with("fix: main edit"));
        assert!(file.index.contains(" 1;") || file.index.contains(" 2;"));
    }

    #[test]
    fn applies_resolution_and_stages_it_unless_the_file_changed() {
        let dir = conflicted_repo();
        let root = dir.path();
        let inputs = conflict_inputs(root).expect("gather");
        let write = write_for(&inputs, "merged\n");

        std::fs::write(root.join("a.txt"), "edited meanwhile\n").expect("write");
        let skipped =
            apply_resolutions(root, &inputs.identity, std::slice::from_ref(&write)).expect("apply");
        assert!(skipped[0].error.is_some());

        let inputs = conflict_inputs(root).expect("gather again");
        let applied = apply_resolutions(root, &inputs.identity, &[write_for(&inputs, "merged\n")])
            .expect("apply");
        assert!(applied[0].error.is_none());
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).expect("read"),
            "merged\n"
        );
        assert!(conflict_inputs(root).expect("gather").files.is_empty());
    }

    #[test]
    fn refuses_decisions_made_for_an_earlier_merge_with_identical_text() {
        let dir = conflicted_repo();
        let root = dir.path();
        let inputs = conflict_inputs(root).expect("gather");
        let write = write_for(&inputs, "merged\n");

        // Abort, advance `main`, and merge again: the conflicted file's text
        // is unchanged but it is a different merge.
        run(root, &["merge", "--abort"]);
        run(root, &["checkout", "main"]);
        std::fs::write(root.join("b.txt"), "unrelated\n").expect("write");
        run(root, &["add", "b.txt"]);
        run(root, &["commit", "-m", "chore: unrelated"]);
        start_merge(root);
        assert_ne!(merge_identity(root).expect("identity"), inputs.identity);

        let skipped = apply_resolutions(root, &inputs.identity, &[write]).expect("apply");
        assert!(skipped[0].error.is_some());
        assert_eq!(conflict_inputs(root).expect("gather").files.len(), 1);
    }

    #[test]
    fn commit_requires_resolved_conflicts_and_an_unchanged_index() {
        let dir = conflicted_repo();
        let root = dir.path();
        assert!(merge_commit_context(root).is_err());

        let inputs = conflict_inputs(root).expect("gather");
        let results = apply_resolutions(root, &inputs.identity, &[write_for(&inputs, "merged\n")])
            .expect("apply");
        assert!(results[0].error.is_none());

        let context = merge_commit_context(root).expect("context");
        assert_eq!(context.files, vec!["a.txt"]);
        assert!(context.diff.contains("merged"));

        std::fs::write(root.join("a.txt"), "changed again\n").expect("write");
        run(root, &["add", "a.txt"]);
        assert!(commit_merge(root, &context.identity, &context.tree, "msg").is_err());

        let context = merge_commit_context(root).expect("context again");
        commit_merge(
            root,
            &context.identity,
            &context.tree,
            "fix: merge conflicts",
        )
        .expect("commit");
        assert!(merge_identity(root).is_err());
    }

    #[test]
    fn merge_identity_requires_a_merge_in_progress() {
        let dir = tempfile::tempdir().expect("tempdir");
        run(dir.path(), &["init"]);
        assert!(merge_identity(dir.path()).is_err());
    }
}
