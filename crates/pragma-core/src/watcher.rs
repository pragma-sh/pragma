//! Worktree-scoped filesystem watcher that drives live file previews.
//!
//! [`WorktreeWatcher`] wraps a recursive `notify` debouncer and translates raw
//! filesystem events into worktree-relative [`FileChange`]s (forward-slash POSIX
//! paths, with `.git` filtered out). `pragma-server` owns one watcher per
//! subscribed worktree and broadcasts each batch to its subscribers.

use std::path::{Component, Path};
use std::time::Duration;

use notify_debouncer_full::notify::event::{MetadataKind, ModifyKind};
use notify_debouncer_full::notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use pragma_constants::{FileChange, FileChangeKind};

use crate::{CoreError, CoreResult};

/// Debounce window that coalesces rapid bursts (e.g. a multi-file save or a
/// `git checkout`) into a single batch before notifying subscribers.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// A recursive filesystem watcher rooted at one worktree.
///
/// Dropping the watcher stops watching: the underlying debouncer owns the
/// background OS-watch thread and is torn down with this value.
pub struct WorktreeWatcher {
    // Held only to keep the watch alive; never read.
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

impl WorktreeWatcher {
    /// Starts watching `root` recursively, invoking `on_change` with each
    /// debounced batch of worktree-relative changes.
    ///
    /// `on_change` runs on the debouncer's own thread, so it must not block for
    /// long. Paths that resolve outside the canonical root, or inside `.git`,
    /// are dropped before the callback fires.
    pub fn new<F>(root: &Path, on_change: F) -> CoreResult<Self>
    where
        F: Fn(Vec<FileChange>) + Send + 'static,
    {
        let canonical_root = pragma_platform::path::canonicalize(root)
            .map_err(|err| CoreError::Operation(format!("watch root {}: {err}", root.display())))?;
        let watch_root = canonical_root.clone();
        let mut debouncer = new_debouncer(DEBOUNCE, None, move |result: DebounceEventResult| {
            let Ok(events) = result else {
                return;
            };
            let mut changes: Vec<FileChange> = Vec::new();
            for event in events {
                let Some(kind) = classify(event.kind) else {
                    continue;
                };
                for path in &event.paths {
                    if let Some(change) = to_change(&canonical_root, path, kind) {
                        changes.push(change);
                    }
                }
            }
            if !changes.is_empty() {
                on_change(changes);
            }
        })
        .map_err(|err| CoreError::Operation(format!("create watcher: {err}")))?;
        debouncer
            .watch(watch_root.as_path(), RecursiveMode::Recursive)
            .map_err(|err| {
                CoreError::Operation(format!("watch {}: {err}", watch_root.display()))
            })?;
        Ok(Self {
            _debouncer: debouncer,
        })
    }
}

/// Collapses a `notify` event kind onto the three preview-relevant outcomes,
/// dropping read/access noise that would make previews reload themselves.
/// Anything else that is not a create or a remove (rename, content/metadata
/// change, or an `Any`/`Other` catch-all) is reported as a modification so the
/// client re-reads the file.
fn classify(kind: EventKind) -> Option<FileChangeKind> {
    if kind.is_access()
        || matches!(
            kind,
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime))
        )
    {
        return None;
    }
    if kind.is_create() {
        Some(FileChangeKind::Created)
    } else if kind.is_remove() {
        Some(FileChangeKind::Removed)
    } else {
        Some(FileChangeKind::Modified)
    }
}

/// Converts an absolute event path into a worktree-relative POSIX [`FileChange`],
/// returning `None` for paths outside the root, the root itself, or anything in
/// `.git`.
fn to_change(root: &Path, path: &Path, kind: FileChangeKind) -> Option<FileChange> {
    let relative = path.strip_prefix(root).ok()?;
    let mut parts: Vec<String> = Vec::new();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        let part = part.to_string_lossy();
        if parts.is_empty() && part == ".git" {
            return None;
        }
        parts.push(part.into_owned());
    }
    if parts.is_empty() {
        return None;
    }
    Some(FileChange {
        path: parts.join("/"),
        kind,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use notify_debouncer_full::notify::event::{AccessKind, AccessMode, CreateKind};
    use pragma_constants::FileChangeKind;
    use tempfile::tempdir;

    use super::WorktreeWatcher;

    #[test]
    fn ignores_paths_outside_root_and_dot_git() {
        let root = std::path::Path::new("/repo");
        assert!(super::to_change(
            root,
            std::path::Path::new("/repo/.git/HEAD"),
            FileChangeKind::Modified
        )
        .is_none());
        assert!(super::to_change(
            root,
            std::path::Path::new("/elsewhere/x"),
            FileChangeKind::Modified
        )
        .is_none());
        assert!(super::to_change(
            root,
            std::path::Path::new("/repo"),
            FileChangeKind::Modified
        )
        .is_none());
        let change = super::to_change(
            root,
            std::path::Path::new("/repo/src/app.ts"),
            FileChangeKind::Modified,
        )
        .expect("path inside root is a change");
        assert_eq!(change.path, "src/app.ts");
    }

    #[test]
    fn reports_a_created_file_under_the_root() {
        let dir = tempdir().expect("tempdir");
        let (tx, rx) = mpsc::channel();
        let _watcher = WorktreeWatcher::new(dir.path(), move |changes| {
            let _ = tx.send(changes);
        })
        .expect("watcher starts");

        std::fs::write(dir.path().join("hello.txt"), "hi").expect("write file");

        // The OS watch backend plus the debounce window add latency; allow a
        // generous deadline before declaring failure.
        let changes = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("a filesystem change should arrive");
        assert!(
            changes.iter().any(|change| change.path == "hello.txt"),
            "expected hello.txt in {changes:?}",
        );
    }

    #[test]
    fn ignores_read_only_access_events() {
        assert_eq!(
            super::classify(super::EventKind::Access(AccessKind::Open(AccessMode::Read))),
            None
        );
        assert_eq!(
            super::classify(super::EventKind::Modify(super::ModifyKind::Metadata(
                super::MetadataKind::AccessTime
            ))),
            None
        );
        assert_eq!(
            super::classify(super::EventKind::Create(CreateKind::File)),
            Some(FileChangeKind::Created)
        );
    }
}
