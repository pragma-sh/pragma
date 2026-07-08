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
/// triggers keep arriving within `DEBOUNCE_IDLE`. Once idle, snapshot and send.
fn worker(rx: Receiver<()>, app: AppHandle, pty: PtyClient) {
    while rx.recv().is_ok() {
        // Drain bursts: keep waiting for more triggers until the channel is
        // quiet for `DEBOUNCE_IDLE`.
        while rx.recv_timeout(DEBOUNCE_IDLE).is_ok() {
            // Keep draining: another mutation landed; reset the idle window.
        }
        if let Err(error) = publish_once(&app, &pty) {
            eprintln!("workspace publish failed: {error}");
        }
    }
}

/// Reads all projects/worktrees/tabs from `Db` and publishes a snapshot.
fn publish_once(app: &AppHandle, pty: &PtyClient) -> AppResult<()> {
    let db = app.state::<Db>();
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
