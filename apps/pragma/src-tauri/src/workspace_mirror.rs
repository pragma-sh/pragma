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

use pragma_constants::Worktree;
use pragma_core::git::{GitRequest, HeadlessWorktree};
use serde_json::Value;
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
            match publish_now(&app) {
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

/// Reconciles host-created fanout rows and immediately publishes the current
/// workspace. Destructive fanout finalization uses this to avoid validating
/// against a hierarchy still waiting in the debounce queue.
pub(crate) fn publish_now(app: &AppHandle) -> AppResult<()> {
    let db = app.state::<Db>();
    let hosts = app.state::<Hosts>();
    adopt_fanout_workspace(&db, &hosts);
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

/// Adopts host-created fanout worktrees and their live agent tabs into the
/// desktop database. Called both by the debounced publisher and synchronously
/// after a desktop fanout create/retry so the RPC cannot return stale UI state.
pub(crate) fn adopt_fanout_workspace(db: &Db, hosts: &Hosts) {
    adopt_headless_worktrees(db, hosts);
    adopt_fanout_tabs(db, hosts);
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
    let known_by_path: HashMap<&str, &Worktree> = worktrees
        .iter()
        .map(|worktree| (worktree.path.as_str(), worktree))
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
        // Fanout worktrees keep their host-owned hierarchy: the coordination
        // parent hangs off its source worktree and every attempt off that
        // parent. Git worktrees carry no parentage, so the durable fanout
        // record is the only place that relationship survives — and the host's
        // pick transaction refuses to merge attempts that are not direct
        // children of their parent.
        let parentage = crate::fanouts::first_snapshot(&client)
            .map(|snapshot| fanout_parentage(&snapshot))
            .unwrap_or_default();
        let request = GitRequest::ListHeadlessWorktrees {
            project_root: project.path.clone(),
        };
        // An unreachable host skips the project until the next publish.
        let Ok(mut candidates) = host_rpc::<Vec<HeadlessWorktree>>(&client, &request) else {
            continue;
        };
        order_fanout_worktrees(&mut candidates, &parentage);
        for HeadlessWorktree { id, path, branch } in candidates {
            let expected_parent = parentage.get(&id);
            if let Some(existing) = known_by_path.get(path.as_str()) {
                if let (true, Some(expected_parent)) = (existing.id == id, expected_parent) {
                    repair_fanout_parent(db, existing, expected_parent);
                }
                continue;
            }
            if db.worktree(&id).is_ok() {
                // The id is taken by a row at a different path (a moved or
                // recreated checkout) — leave it for the user to resolve.
                continue;
            }
            let parent_id = expected_parent.map_or(main_id.as_str(), String::as_str);
            match db.insert_worktree(&id, &project.id, parent_id, &branch, None, &path) {
                Ok(_) => log::info!("adopted headless worktree {id} ({branch}) at {path}"),
                Err(error) => log::warn!("failed to adopt headless worktree {id}: {error}"),
            }
        }
    }
}

/// Inserts every candidate after any candidate it names as its parent.
fn order_fanout_worktrees(
    candidates: &mut [HeadlessWorktree],
    parentage: &HashMap<String, String>,
) {
    let candidate_ids: HashSet<String> = candidates
        .iter()
        .map(|candidate| candidate.id.clone())
        .collect();
    candidates.sort_by_key(|candidate| {
        let mut current = &candidate.id;
        let mut depth = 0;
        while let Some(parent) = parentage.get(current) {
            if !candidate_ids.contains(parent) || depth == candidate_ids.len() {
                break;
            }
            depth += 1;
            current = parent;
        }
        depth
    });
}

/// Corrects a row previously adopted under the main worktree fallback.
fn repair_fanout_parent(db: &Db, worktree: &Worktree, expected_parent: &str) {
    if worktree.parent_id.as_deref() == Some(expected_parent) {
        return;
    }
    match db.set_worktree_parent(&worktree.id, expected_parent) {
        Ok(_) => log::info!(
            "reparented fanout worktree {} under {}",
            worktree.id,
            expected_parent
        ),
        Err(error) => log::warn!(
            "failed to reparent fanout worktree {} under {}: {error}",
            worktree.id,
            expected_parent
        ),
    }
}

/// Maps a fanout's worktrees to their host-owned parents.
///
/// `adopt_headless_worktrees` defaults an unaccounted-for checkout to the
/// project's main worktree, but a fanout's hierarchy must survive adoption: the
/// coordination parent belongs under its source worktree, and every attempt
/// under that parent. Without this the host's `validate_finalize` rejects the
/// pick because an attempt is no longer a direct child of its fanout parent.
fn fanout_parentage(snapshot: &Value) -> HashMap<String, String> {
    let mut parents = HashMap::new();
    for fanout in snapshot["fanouts"].as_array().into_iter().flatten() {
        let Some(parent) = fanout["parentWorktreeId"].as_str() else {
            continue;
        };
        if let Some(source) = fanout["sourceWorktreeId"].as_str() {
            parents.insert(parent.to_string(), source.to_string());
        }
        for member in fanout["members"].as_array().into_iter().flatten() {
            if let Some(attempt) = member["worktreeId"].as_str() {
                parents.insert(attempt.to_string(), parent.to_string());
            }
        }
    }
    parents
}

/// Adopts the terminal tabs `pragma-server` created for fanout attempts.
///
/// Each attempt is a real agent session with a live PTY the host keyed by *its*
/// tab id, so the row has to be adopted under that same id: minting a new one
/// would open a second terminal beside the running agent instead of attaching
/// to it. That is also what makes a reopened desktop attach rather than
/// relaunch. Tab ownership stays out of this beyond the row itself — the fanout
/// relation lives in the host's durable record.
fn adopt_fanout_tabs(db: &Db, hosts: &Hosts) {
    let Ok(projects) = db.list_projects() else {
        return;
    };
    for project in &projects {
        let Ok(client) = hosts.for_project(db, &project.id) else {
            continue;
        };
        let Ok(snapshot) = crate::fanouts::first_snapshot(&client) else {
            continue;
        };
        for fanout in snapshot["fanouts"].as_array().into_iter().flatten() {
            if fanout["projectId"].as_str() != Some(project.id.as_str()) {
                continue;
            }
            for member in fanout["members"].as_array().into_iter().flatten() {
                let (Some(tab_id), Some(worktree_id)) =
                    (member["tabId"].as_str(), member["worktreeId"].as_str())
                else {
                    continue;
                };
                if db.worktree(worktree_id).is_err() {
                    // The attempt's worktree has not been adopted yet; its tab
                    // arrives on the next publish.
                    continue;
                }
                let agent_id = member["catalogAgentId"].as_str().unwrap_or_default();
                if let Err(error) = db.adopt_agent_tab(
                    tab_id,
                    &project.id,
                    worktree_id,
                    Some(
                        fanout["title"]
                            .as_str()
                            .unwrap_or("Fanout attempt")
                            .to_string(),
                    ),
                    agent_id,
                ) {
                    log::warn!("failed to adopt fanout tab {tab_id}: {error}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{fanout_parentage, order_fanout_worktrees};
    use pragma_core::git::HeadlessWorktree;
    use serde_json::json;

    #[test]
    fn fanout_parentage_maps_attempts_to_their_parent_and_the_parent_to_its_source() {
        let snapshot = json!({
            "fanouts": [{
                "parentWorktreeId": "parent-1",
                "sourceWorktreeId": "source-1",
                "members": [
                    { "worktreeId": "attempt-a" },
                    { "worktreeId": "attempt-b" }
                ]
            }, {
                "parentWorktreeId": "existing-parent",
                "sourceWorktreeId": null,
                "members": [
                    { "worktreeId": "attempt-c" }
                ]
            }]
        });
        let parents = fanout_parentage(&snapshot);
        assert_eq!(
            parents.get("parent-1").map(String::as_str),
            Some("source-1")
        );
        assert_eq!(
            parents.get("attempt-a").map(String::as_str),
            Some("parent-1")
        );
        assert_eq!(
            parents.get("attempt-b").map(String::as_str),
            Some("parent-1")
        );
        assert_eq!(
            parents.get("attempt-c").map(String::as_str),
            Some("existing-parent")
        );
        // An existing parent is not headless, so nothing maps it to a source.
        assert!(!parents.contains_key("existing-parent"));
    }

    #[test]
    fn fanout_parentage_ignores_members_without_worktrees() {
        let snapshot = json!({
            "fanouts": [{
                "parentWorktreeId": "parent-1",
                "sourceWorktreeId": "source-1",
                "members": [
                    { "worktreeId": "attempt-a" },
                    { "worktreeId": null }
                ]
            }]
        });
        let parents = fanout_parentage(&snapshot);
        assert_eq!(parents.len(), 2);
        assert_eq!(
            parents.get("parent-1").map(String::as_str),
            Some("source-1")
        );
        assert_eq!(
            parents.get("attempt-a").map(String::as_str),
            Some("parent-1")
        );
    }

    #[test]
    fn fanout_coordination_parent_is_adopted_before_its_attempts() {
        let mut candidates = vec![
            HeadlessWorktree {
                id: "attempt-a".to_string(),
                path: "/repo/.pragma/worktrees/attempt-a".to_string(),
                branch: "fanout/a".to_string(),
            },
            HeadlessWorktree {
                id: "parent-1".to_string(),
                path: "/repo/.pragma/worktrees/parent-1".to_string(),
                branch: "fanout-parent".to_string(),
            },
            HeadlessWorktree {
                id: "source-1".to_string(),
                path: "/repo/.pragma/worktrees/source-1".to_string(),
                branch: "source".to_string(),
            },
        ];
        let parentage = std::collections::HashMap::from([
            ("parent-1".to_string(), "source-1".to_string()),
            ("attempt-a".to_string(), "parent-1".to_string()),
        ]);

        order_fanout_worktrees(&mut candidates, &parentage);

        assert_eq!(candidates[0].id, "source-1");
        assert_eq!(candidates[1].id, "parent-1");
        assert_eq!(candidates[2].id, "attempt-a");
    }
}
