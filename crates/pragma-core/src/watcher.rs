//! Worktree-scoped filesystem watcher that drives live file previews.
//!
//! [`WorktreeWatcher`] wraps a recursive `notify` debouncer and translates raw
//! filesystem events into worktree-relative [`FileChange`]s (forward-slash POSIX
//! paths, with the worktree root's `.git` metadata filtered out). `pragma-server` owns one watcher per
//! subscribed worktree and broadcasts each batch to its subscribers.

use std::path::{Component, Path};
use std::time::Duration;

use notify_debouncer_full::notify::event::{MetadataKind, ModifyKind};
use notify_debouncer_full::notify::{Config, EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use pragma_constants::{FileChange, FileChangeKind};

use crate::{CoreError, CoreResult};

/// Debounce window that coalesces rapid bursts (e.g. a multi-file save or a
/// `git checkout`) into a single batch before notifying subscribers.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// A recursive filesystem watcher rooted at one worktree.
///
/// Dropping the watcher synchronously stops watching and joins the debouncer's
/// event thread. It must therefore be dropped outside its own `on_change`
/// callback (the server schedules callback-initiated cleanup on another
/// thread).
pub struct WorktreeWatcher {
    // Optional so `Drop` can consume the debouncer and synchronously stop its
    // event thread. The value is always `Some` outside teardown.
    debouncer: Option<Debouncer<RecommendedWatcher, NoCache>>,
}

impl WorktreeWatcher {
    /// Starts watching `root` recursively, invoking `on_change` with each
    /// debounced batch of worktree-relative changes.
    ///
    /// `on_change` runs on the debouncer's own thread, so it must not block for
    /// long or directly drop this watcher. Paths that resolve outside the
    /// canonical root, or inside the root's `.git`, are dropped before the callback fires.
    pub fn new<F>(root: &Path, on_change: F) -> CoreResult<Self>
    where
        F: Fn(Vec<FileChange>) + Send + 'static,
    {
        let canonical_root = pragma_platform::path::canonicalize(root)
            .map_err(|err| CoreError::Operation(format!("watch root {}: {err}", root.display())))?;
        let watch_root = canonical_root.clone();
        // `RecommendedCache` is a `FileIdMap` on macOS and Windows. Registering
        // a recursive root makes that cache eagerly walk the entire tree,
        // follow symlinks, stat every entry, and retain every path for the
        // watcher's lifetime. Large dependency trees and nested Pragma
        // worktrees therefore multiply startup time and memory even though we
        // only need invalidation events. `NoCache` keeps the same OS watcher
        // and debounce behavior without the eager scan. Rename-cookie backends
        // still coalesce renames; other backends may emit the equivalent
        // remove/create pair, which the client already understands.
        let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            DEBOUNCE,
            None,
            move |result: DebounceEventResult| {
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
            },
            NoCache::new(),
            Config::default(),
        )
        .map_err(|err| CoreError::Operation(format!("create watcher: {err}")))?;
        if let Err(err) = debouncer.watch(watch_root.as_path(), RecursiveMode::Recursive) {
            // Registration failed, so there is no live watcher to return; do
            // not leave the already-started debounce thread winding down in
            // the background.
            debouncer.stop();
            return Err(CoreError::Operation(format!(
                "watch {}: {err}",
                watch_root.display()
            )));
        }
        Ok(Self {
            debouncer: Some(debouncer),
        })
    }
}

impl Drop for WorktreeWatcher {
    fn drop(&mut self) {
        if let Some(debouncer) = self.debouncer.take() {
            // Unlike `Debouncer`'s non-blocking `Drop`, `stop` joins the event
            // thread. Callers can therefore rely on teardown having completed
            // when a worktree is removed, with no late callback racing a new
            // watcher for the same path.
            debouncer.stop();
        }
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
/// the root's `.git`.
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
    fn preserves_dependency_build_and_nested_worktree_changes() {
        let root = std::path::Path::new("/repo");
        for relative in [
            "node_modules/package/index.js",
            "target/debug/app",
            ".pragma/worktrees/child/src/lib.rs",
        ] {
            let path = root.join(relative);
            let change = super::to_change(root, &path, FileChangeKind::Modified)
                .unwrap_or_else(|| panic!("{relative} should remain visible to file previews"));
            assert_eq!(change.path, relative);
        }
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
    fn reports_both_paths_when_a_file_is_renamed() {
        let dir = tempdir().expect("tempdir");
        let old_path = dir.path().join("before.txt");
        let new_path = dir.path().join("after.txt");
        std::fs::write(&old_path, "contents").expect("write original file");

        let (tx, rx) = mpsc::channel();
        let _watcher = WorktreeWatcher::new(dir.path(), move |changes| {
            let _ = tx.send(changes);
        })
        .expect("watcher starts");

        std::fs::rename(old_path, new_path).expect("rename file");

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut paths = std::collections::HashSet::new();
        while std::time::Instant::now() < deadline
            && !(paths.contains("before.txt") && paths.contains("after.txt"))
        {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let Ok(changes) = rx.recv_timeout(remaining) else {
                break;
            };
            paths.extend(changes.into_iter().map(|change| change.path));
        }

        assert!(
            paths.contains("before.txt") && paths.contains("after.txt"),
            "rename should invalidate the source and destination paths, got {paths:?}"
        );
    }

    #[test]
    fn drop_waits_for_the_debouncer_thread_to_exit() {
        struct DropSignal(mpsc::Sender<()>);

        impl Drop for DropSignal {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }

        let dir = tempdir().expect("tempdir");
        let (tx, rx) = mpsc::channel();
        let signal = DropSignal(tx);
        let watcher = WorktreeWatcher::new(dir.path(), move |_| {
            // Keep the signal owned by the event-handler closure. It is
            // dropped only when the debouncer thread has exited.
            let _ = &signal;
        })
        .expect("watcher starts");

        drop(watcher);

        rx.try_recv()
            .expect("dropping the watcher should synchronously join its event thread");
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
