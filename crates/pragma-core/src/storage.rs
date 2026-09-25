//! Worktree disk usage behind the `filesystem` RPC's storage operations.
//!
//! A scan walks one trusted worktree root on the host that owns it and reports
//! its total size, the largest files, and the gitignored folders the user may
//! reclaim. Three rules keep the numbers honest and the deletions safe:
//!
//! - **Linked Pragma worktrees are not part of the main checkout.** They live
//!   under `<project>/.pragma/worktrees/`, so a naive walk of the main checkout
//!   would count every worktree twice. The walk skips that directory; each
//!   worktree is scanned on its own.
//! - **Sizes are allocated bytes, and a hard-linked file is charged once** (see
//!   `pragma_platform::disk`), so a pnpm/bun store linked into every
//!   `node_modules` is not multiplied by the number of links.
//! - **Git decides what is ignored, and the host re-checks before deleting.**
//!   `git ls-files --ignored --directory` names the ignored folders; a delete
//!   request is refused unless the folder is still gitignored, is a real
//!   directory rather than a link, and is outside every
//!   `constants.storage.protectedFolders` entry. The client's list is never
//!   trusted as proof.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use pragma_constants::{StorageFile, StorageFolder, WorktreeStorage, CONSTANTS};

use crate::cancel::{CancelRegistry, CancelToken};
use crate::fs::{resolve_in_worktree, validate_relative};
use crate::git::PRAGMA_WORKTREES_EXCLUDE;
use crate::process_env;
use crate::storage_tree::TopLevel;
use crate::{CoreError, CoreResult};

/// Scans that may run at once on one host. The page itself runs
/// `constants.storage.scanConcurrency`; the headroom covers a second window.
const MAX_CONCURRENT_SCANS: usize = if cfg!(test) { 1_024 } else { 8 };

static ACTIVE_SCANS: CancelRegistry = CancelRegistry::new("storage scan", MAX_CONCURRENT_SCANS);

/// Which total a walked entry is charged to, beyond the worktree's own.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Bucket {
    Plain,
    Git,
    Ignored(usize),
}

/// Running totals for one gitignored folder.
struct FolderTally {
    path: String,
    bytes: u64,
    file_count: u64,
}

/// Accumulates one walk's results.
struct Tally {
    total_bytes: u64,
    file_count: u64,
    git_bytes: u64,
    entries: u64,
    folders: Vec<FolderTally>,
    large: BinaryHeap<Reverse<(u64, String, bool)>>,
    seen_links: HashSet<pragma_platform::disk::FileIdentity>,
    tree: TopLevel,
}

impl Tally {
    fn add_file(
        &mut self,
        relative: String,
        metadata: &std::fs::Metadata,
        bucket: Bucket,
        top: Option<usize>,
    ) {
        if let Some(identity) = pragma_platform::disk::shared_identity(metadata) {
            if !self.seen_links.insert(identity) {
                return;
            }
        }
        let bytes = pragma_platform::disk::allocated_bytes(metadata);
        self.total_bytes = self.total_bytes.saturating_add(bytes);
        self.file_count += 1;
        self.tree.add_file(top, bytes);
        match bucket {
            Bucket::Plain => {}
            Bucket::Git => self.git_bytes = self.git_bytes.saturating_add(bytes),
            Bucket::Ignored(index) => {
                let folder = &mut self.folders[index];
                folder.bytes = folder.bytes.saturating_add(bytes);
                folder.file_count += 1;
            }
        }
        let storage = &CONSTANTS.storage;
        if bytes < storage.large_file_min_bytes.get() {
            return;
        }
        self.large.push(Reverse((
            bytes,
            relative,
            matches!(bucket, Bucket::Ignored(_)),
        )));
        if self.large.len() > usize::try_from(storage.large_file_limit.get()).unwrap_or(usize::MAX)
        {
            self.large.pop();
        }
    }
}

/// Scans `root` and reports its disk usage. `scan_id` lets a second call stop
/// it early through [`cancel_scan`]; a stopped scan returns what it had counted
/// with `truncated` set.
///
/// # Errors
///
/// Fails when the root cannot be canonicalized or another scan limit is hit.
pub fn scan(scan_id: &str, root: &str) -> CoreResult<WorktreeStorage> {
    let token = ACTIVE_SCANS.register(scan_id)?;
    let root = pragma_platform::path::canonicalize(root)?;
    let ignored = ignored_folders(&root);
    let index: HashMap<String, usize> = ignored
        .iter()
        .enumerate()
        .map(|(index, path)| (path.clone(), index))
        .collect();
    let mut tally = Tally {
        total_bytes: 0,
        file_count: 0,
        git_bytes: 0,
        entries: 0,
        folders: ignored
            .into_iter()
            .map(|path| FolderTally {
                path,
                bytes: 0,
                file_count: 0,
            })
            .collect(),
        large: BinaryHeap::new(),
        seen_links: HashSet::new(),
        tree: TopLevel::new(),
    };
    let truncated = walk(&root, &index, &mut tally, &token);
    Ok(finish(tally, truncated))
}

/// Asks the scan registered as `scan_id` to stop. Safe once it has finished.
pub fn cancel_scan(scan_id: &str) {
    ACTIVE_SCANS.cancel(scan_id);
}

/// Walks the tree iteratively (a deep `node_modules` would overflow a
/// recursive walk's stack). Returns whether the walk stopped early.
fn walk(
    root: &Path,
    ignored: &HashMap<String, usize>,
    tally: &mut Tally,
    token: &CancelToken<'_>,
) -> bool {
    let worktrees_dir = PRAGMA_WORKTREES_EXCLUDE.trim_end_matches('/');
    let max_entries = CONSTANTS.storage.max_scan_entries.get();
    // The last element is the top-level folder being walked (`None` at the root).
    let mut stack: Vec<(PathBuf, String, Bucket, Option<usize>)> =
        vec![(root.to_path_buf(), String::new(), Bucket::Plain, None)];
    while let Some((directory, prefix, bucket, top)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            tally.entries += 1;
            if tally.entries > max_entries || token.is_cancelled() {
                return true;
            }
            // `DirEntry::metadata` does not follow symlinks, so a link is
            // never walked into and never charged for its target.
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if metadata.is_dir() {
                if relative == worktrees_dir {
                    continue;
                }
                let bucket = match bucket {
                    Bucket::Plain if relative == ".git" => Bucket::Git,
                    Bucket::Plain => ignored
                        .get(&relative)
                        .map_or(Bucket::Plain, |index| Bucket::Ignored(*index)),
                    inherited => inherited,
                };
                let top = top.or_else(|| Some(tally.tree.add_folder(name)));
                stack.push((entry.path(), relative, bucket, top));
            } else if metadata.is_file() {
                let bucket = if bucket == Bucket::Plain && relative == ".git" {
                    Bucket::Git
                } else {
                    bucket
                };
                tally.add_file(relative, &metadata, bucket, top);
            }
        }
    }
    false
}

fn finish(tally: Tally, truncated: bool) -> WorktreeStorage {
    let min_folder = CONSTANTS.storage.ignored_folder_min_bytes;
    let ignored_bytes = tally
        .folders
        .iter()
        .fold(0_u64, |sum, folder| sum.saturating_add(folder.bytes));
    let mut ignored_folders: Vec<StorageFolder> = tally
        .folders
        .into_iter()
        .filter(|folder| folder.bytes >= min_folder && !is_protected(&folder.path))
        .map(|folder| StorageFolder {
            path: folder.path,
            bytes: folder.bytes,
            file_count: folder.file_count,
        })
        .collect();
    ignored_folders.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.path.cmp(&b.path)));
    let large_files = tally
        .large
        .into_sorted_vec()
        .into_iter()
        .map(|Reverse((bytes, path, ignored))| StorageFile {
            path,
            bytes,
            ignored,
        })
        .collect();
    WorktreeStorage {
        tree: tally.tree.finish(),
        total_bytes: tally.total_bytes,
        file_count: tally.file_count,
        git_bytes: tally.git_bytes,
        ignored_bytes,
        large_files,
        ignored_folders,
        truncated,
    }
}

/// Gitignored folders directly reported by git, relative and without the
/// trailing slash. `--directory` collapses an ignored folder into one entry, so
/// the list never nests. A non-git root has none.
fn ignored_folders(root: &Path) -> Vec<String> {
    process_env::git()
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            output
                .stdout
                .split(|byte| *byte == 0)
                .filter_map(|entry| {
                    let entry = String::from_utf8_lossy(entry);
                    entry
                        .strip_suffix('/')
                        .filter(|path| !path.is_empty())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Whether `relative` is, or lies under, a folder the host never deletes.
fn is_protected(relative: &str) -> bool {
    CONSTANTS.storage.protected_folders.iter().any(|folder| {
        relative == folder
            || relative
                .strip_prefix(folder.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// Deletes one gitignored folder after re-checking, on the host, that it is
/// still safe to delete.
///
/// # Errors
///
/// Refuses a protected, non-ignored, non-directory, or escaping path, and
/// propagates the removal's I/O error.
pub fn delete_ignored_folder(root: &str, path: &str) -> CoreResult<()> {
    let relative = validate_relative(path)?;
    let relative_text = relative.to_string_lossy().replace('\\', "/");
    if relative_text.is_empty() || is_protected(&relative_text) {
        return Err(CoreError::InvalidPayload(format!(
            "{relative_text} is protected and cannot be deleted from Storage"
        )));
    }
    let target = resolve_in_worktree(Path::new(root), path)?;
    let metadata = std::fs::symlink_metadata(&target)?;
    if !metadata.is_dir() {
        return Err(CoreError::InvalidPayload(format!(
            "{relative_text} is not a folder"
        )));
    }
    if !is_git_ignored(Path::new(root), &relative_text) {
        return Err(CoreError::InvalidPayload(format!(
            "{relative_text} is not gitignored"
        )));
    }
    std::fs::remove_dir_all(&target)?;
    Ok(())
}

/// Asks git whether a folder is ignored. The trailing slash lets directory-only
/// patterns (`node_modules/`) match without git having to stat the path.
fn is_git_ignored(root: &Path, relative: &str) -> bool {
    process_env::git()
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "-q", "--"])
        .arg(format!("{relative}/"))
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command;

    use tempfile::tempdir;

    use super::{delete_ignored_folder, is_protected, scan};

    fn git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn write(root: &Path, relative: &str, bytes: usize) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, vec![1_u8; bytes]).unwrap();
    }

    /// A repo with a tracked file, an ignored `node_modules`, a protected
    /// `.pragma`, and a linked worktree nested where Pragma puts them.
    fn fixture() -> tempfile::TempDir {
        let dir = tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join(".gitignore"), "node_modules/\n.pragma/\n").unwrap();
        write(root, "src/app.ts", 4096);
        write(root, "node_modules/pkg/index.js", 2 * 1024 * 1024);
        write(root, ".pragma/config.json", 2 * 1024 * 1024);
        write(root, ".pragma/worktrees/other/huge.bin", 8 * 1024 * 1024);
        dir
    }

    #[test]
    fn scan_counts_ignored_folders_and_skips_nested_worktrees() {
        let dir = fixture();
        let root = dir.path().to_string_lossy().into_owned();
        let storage = scan("scan-a", &root).unwrap();

        assert!(!storage.truncated);
        assert!(storage.git_bytes > 0);
        assert!(storage.ignored_bytes >= 4 * 1024 * 1024);
        // The nested worktree's 8 MiB belongs to its own scan.
        assert!(storage.total_bytes < 8 * 1024 * 1024);
        let folders: Vec<&str> = storage
            .ignored_folders
            .iter()
            .map(|folder| folder.path.as_str())
            .collect();
        assert_eq!(folders, vec!["node_modules"]);
        assert_eq!(storage.ignored_folders[0].file_count, 1);
    }

    #[test]
    fn delete_refuses_tracked_and_protected_folders() {
        let dir = fixture();
        let root = dir.path().to_string_lossy().into_owned();

        assert!(delete_ignored_folder(&root, "src").is_err());
        assert!(delete_ignored_folder(&root, ".pragma").is_err());
        assert!(delete_ignored_folder(&root, ".git").is_err());
        assert!(delete_ignored_folder(&root, "../elsewhere").is_err());
        assert!(dir.path().join("src/app.ts").exists());

        delete_ignored_folder(&root, "node_modules").unwrap();
        assert!(!dir.path().join("node_modules").exists());
    }

    #[test]
    fn a_response_without_a_tree_still_decodes() {
        // A host built before the size tree existed sends none; the client
        // must still read its totals instead of failing the whole scan.
        let legacy = serde_json::json!({
            "totalBytes": 10, "fileCount": 1, "gitBytes": 0, "ignoredBytes": 0,
            "largeFiles": [], "ignoredFolders": [], "truncated": false
        });
        let storage: pragma_constants::WorktreeStorage = serde_json::from_value(legacy).unwrap();
        assert!(storage.tree.is_empty());
        assert_eq!(storage.total_bytes, 10);
    }

    #[test]
    fn protection_covers_descendants_but_not_lookalikes() {
        assert!(is_protected(".pragma"));
        assert!(is_protected(".pragma/worktrees"));
        assert!(!is_protected(".pragmatic"));
    }
}
