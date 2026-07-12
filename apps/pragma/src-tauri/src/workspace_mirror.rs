//! Workspace mirror publisher.
//!
//! The desktop app is the single source of truth for projects/worktrees/tabs
//! (its `SQLite` DB). It publishes a full `WorkspaceSnapshot` to `pragma-server`
//! so remote clients (a paired phone) can render the session launcher without
//! registering as the controller. Snapshot-and-replace keeps v1 trivial — row
//! deltas are a later optimization.
//!
//! Mutations happen on many paths (Tauri commands, brokered `control.rs`
//! handlers, the CLI broker). Each calls `WorkspacePublisher::trigger()`, a
//! non-blocking send on a bounded channel. A single worker thread drains the
//! channel, coalesces bursts with a ~250ms idle delay, reads all rows from
//! `Db`, and sends `PublishWorkspace`. The work never runs on the main thread;
//! a fast burst of mutations yields a single publish.

use std::collections::HashSet;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::error::AppResult;
use crate::pty::PtyClient;

/// Coalesce window: while mutations keep arriving, the publisher waits this
/// long after the latest one before sending a snapshot. Keeps a burst of
/// `create_tab` + `rename_tab` + reorder as one publish.
const DEBOUNCE_IDLE: Duration = Duration::from_millis(250);

/// How many times a failed publish is retried before giving up until the next
/// trigger. The usual failure is a transient one: the control bridge triggers a
/// publish right after `pragma-server` restarts, while the server socket is not
/// accepting yet. Without a retry that publish is lost and a paired phone sees
/// an empty workspace until the next local mutation.
const PUBLISH_RETRIES: usize = 5;

/// Delay between publish retries.
const PUBLISH_RETRY_DELAY: Duration = Duration::from_secs(1);

/// Managed state: a cheap handle that triggers a debounced workspace publish.
/// Cheap to clone (the channel is shared); only one worker thread runs.
#[derive(Clone)]
pub struct WorkspacePublisher {
    tx: Sender<()>,
}

impl WorkspacePublisher {
    /// Spawns the worker thread and returns the trigger handle. The worker
    /// owns its own `PragmaClient` clone + `AppHandle` so it reads `Db` off the
    /// macOS main thread.
    pub fn start(app: AppHandle, pty: PtyClient) -> Self {
        let (tx, rx) = mpsc::channel::<()>();
        thread::spawn(move || worker(rx, app, pty));
        Self { tx }
    }

    /// Schedules a debounced publish. Non-blocking: a full channel is dropped,
    /// since a publish is already queued.
    pub fn trigger(&self) {
        let _ = self.tx.send(());
    }
}

/// Worker loop: wait for the first trigger, then keep draining as long as
/// triggers keep arriving within `DEBOUNCE_IDLE`. Once idle, snapshot and send,
/// retrying transient failures so a publish triggered right after a server
/// restart is not silently lost.
fn worker(rx: Receiver<()>, app: AppHandle, pty: PtyClient) {
    while rx.recv().is_ok() {
        // Drain bursts: keep waiting for more triggers until the channel is
        // quiet for `DEBOUNCE_IDLE`.
        while rx.recv_timeout(DEBOUNCE_IDLE).is_ok() {
            // Keep draining: another mutation landed; reset the idle window.
        }
        for attempt in 0..=PUBLISH_RETRIES {
            match publish_once(&app, &pty) {
                Ok(()) => break,
                Err(error) if attempt < PUBLISH_RETRIES => {
                    eprintln!("workspace publish failed (attempt {attempt}): {error}");
                    thread::sleep(PUBLISH_RETRY_DELAY);
                }
                Err(error) => {
                    eprintln!("workspace publish failed, giving up until next trigger: {error}");
                }
            }
        }
    }
}

/// Reads all projects/worktrees/tabs from `Db` and publishes a snapshot.
fn publish_once(app: &AppHandle, pty: &PtyClient) -> AppResult<()> {
    let db = app.state::<Db>();
    adopt_headless_worktrees(&db);
    let projects = db.list_projects()?;
    let worktrees = db.list_all_worktrees()?;
    let tabs = db.list_all_tabs()?;
    let snapshot = pragma_protocol::WorkspaceSnapshot {
        projects,
        worktrees,
        tabs,
    };
    pty.publish_workspace(&snapshot)?;
    Ok(())
}

/// Adopts git worktrees `pragma-server` created headlessly (a phone launching
/// an agent into a fresh worktree while the app was closed): any checkout
/// under `<project>/.pragma/worktrees/` the DB does not know becomes a row
/// parented to the project's main worktree, so the sidebar shows it and the
/// snapshot the mirror is about to publish keeps it. The directory name is the
/// worktree id the server minted, keeping remote clients' ids stable across
/// the adoption. Best-effort: failures are logged, never fatal to a publish.
fn adopt_headless_worktrees(db: &Db) {
    let (Ok(projects), Ok(worktrees)) = (db.list_projects(), db.list_all_worktrees()) else {
        return;
    };
    let known_paths: HashSet<&str> = worktrees
        .iter()
        .map(|worktree| worktree.path.as_str())
        .collect();
    for project in &projects {
        let Some(main_id) = worktrees
            .iter()
            .find(|worktree| worktree.project_id == project.id && worktree.is_main)
            .map(|worktree| worktree.id.clone())
        else {
            continue;
        };
        // Remote (SSH) project paths do not exist locally; read_dir fails and
        // the project is skipped — adoption is a local-host concern.
        let Ok(entries) = std::fs::read_dir(Path::new(&project.path).join(".pragma/worktrees"))
        else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let path_str = path.to_string_lossy().into_owned();
            if !path.join(".git").exists() || known_paths.contains(path_str.as_str()) {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if db.worktree(&id).is_ok() {
                // The id is taken by a row at a different path (a moved or
                // recreated checkout) — leave it for the user to resolve.
                continue;
            }
            let Some(branch) = current_git_branch(&path) else {
                continue;
            };
            match db.insert_worktree(&id, &project.id, &main_id, &branch, None, &path_str) {
                Ok(_) => log::info!("adopted headless worktree {id} ({branch}) at {path_str}"),
                Err(error) => log::warn!("failed to adopt headless worktree {id}: {error}"),
            }
        }
    }
}

/// The branch checked out at `path`, or `None` when `path` is not a usable git
/// worktree (adoption skips it).
fn current_git_branch(path: &Path) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["-C"])
        .arg(path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!branch.is_empty() && branch != "HEAD").then_some(branch)
}
