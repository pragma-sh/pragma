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

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

use pragma_core::git::{GitRequest, HeadlessWorktree};
use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::error::AppResult;
use crate::git::host_rpc;
use crate::hosts::Hosts;

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
    /// owns an `AppHandle` so it reads `Db` and routes snapshots to each owning
    /// host off the macOS main thread.
    pub fn start(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<()>();
        thread::spawn(move || worker(rx, app));
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
fn worker(rx: Receiver<()>, app: AppHandle) {
    while rx.recv().is_ok() {
        // Drain bursts: keep waiting for more triggers until the channel is
        // quiet for `DEBOUNCE_IDLE`.
        while rx.recv_timeout(DEBOUNCE_IDLE).is_ok() {
            // Keep draining: another mutation landed; reset the idle window.
        }
        for attempt in 0..=PUBLISH_RETRIES {
            match publish_once(&app) {
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

/// Reads all projects/worktrees/tabs from `Db` and publishes one snapshot to
/// every owning host. Remote hosts need their own snapshot: daemon-owned tab
/// metadata must stay with the PTY host rather than the desktop shell.
fn publish_once(app: &AppHandle) -> AppResult<()> {
    let db = app.state::<Db>();
    let hosts = app.state::<Hosts>();
    adopt_headless_worktrees(&db, &hosts);
    let projects = db.list_projects()?;
    let worktrees = db.list_all_worktrees()?;
    let tabs = db.list_all_tabs()?;
    let mut snapshots = HashMap::new();
    let mut project_hosts = HashMap::new();
    for project in projects {
        let host_id = hosts.host_id_for_project_path(&project.path);
        project_hosts.insert(project.id.clone(), host_id.clone());
        snapshots
            .entry(host_id)
            .or_insert_with(empty_snapshot)
            .projects
            .push(project);
    }
    for worktree in worktrees {
        if let Some(host_id) = project_hosts.get(&worktree.project_id) {
            snapshots
                .entry(host_id.clone())
                .or_insert_with(empty_snapshot)
                .worktrees
                .push(worktree);
        }
    }
    for tab in tabs {
        if let Some(host_id) = project_hosts.get(&tab.project_id) {
            snapshots
                .entry(host_id.clone())
                .or_insert_with(empty_snapshot)
                .tabs
                .push(tab);
        }
    }
    for (host_id, snapshot) in snapshots {
        // A disconnected remote will receive its full snapshot on its next
        // successful publish after reconnect; local projects keep publishing.
        let Ok(client) = hosts.client_for_host(&host_id) else {
            continue;
        };
        client.publish_workspace(&snapshot)?;
    }
    Ok(())
}

fn empty_snapshot() -> pragma_protocol::WorkspaceSnapshot {
    pragma_protocol::WorkspaceSnapshot {
        projects: Vec::new(),
        worktrees: Vec::new(),
        tabs: Vec::new(),
    }
}

/// Adopts git worktrees `pragma-server` created headlessly (a phone launching
/// an agent into a fresh worktree while the app was closed): any checkout
/// under `<project>/.pragma/worktrees/` the DB does not know becomes a row
/// parented to the project's main worktree, so the sidebar shows it and the
/// snapshot the mirror is about to publish keeps it. The directory name is the
/// worktree id the server minted, keeping remote clients' ids stable across
/// the adoption. The disk scan runs on the project's host via the `git` RPC
/// (`ListHeadlessWorktrees`), so remote (SSH) projects are scanned on the
/// machine that owns them. Best-effort: failures are logged, never fatal to a
/// publish.
fn adopt_headless_worktrees(db: &Db, hosts: &Hosts) {
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
        let Ok(client) = hosts.for_project(db, &project.id) else {
            continue;
        };
        let request = GitRequest::ListHeadlessWorktrees {
            project_root: project.path.clone(),
        };
        // An unreachable host skips the project until the next publish.
        let Ok(candidates) = host_rpc::<Vec<HeadlessWorktree>>(&client, &request) else {
            continue;
        };
        for HeadlessWorktree { id, path, branch } in candidates {
            if known_paths.contains(path.as_str()) {
                continue;
            }
            if db.worktree(&id).is_ok() {
                // The id is taken by a row at a different path (a moved or
                // recreated checkout) — leave it for the user to resolve.
                continue;
            }
            match db.insert_worktree(&id, &project.id, &main_id, &branch, None, &path) {
                Ok(_) => log::info!("adopted headless worktree {id} ({branch}) at {path}"),
                Err(error) => log::warn!("failed to adopt headless worktree {id}: {error}"),
            }
        }
    }
}
