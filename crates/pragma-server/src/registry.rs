use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use pragma_constants::ProtocolEventKind;
use pragma_core::watcher::WorktreeWatcher;
use pragma_protocol::{AgentReportPayload, AgentStatus, ControlResult, EventFrame};
use thiserror::Error;

use crate::session::{Session, SessionError};

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("session already exists: {0}")]
    AlreadyExists(String),
    #[error("session not found: {0}")]
    NotFound(String),
    #[error(transparent)]
    Session(#[from] SessionError),
    #[error("filesystem watcher failed: {0}")]
    Watcher(String),
    #[error("lock poisoned")]
    LockPoisoned,
}

/// The controller (the GUI app) reply forwarding is done on the controller's
/// own connection thread (it reads `ControlResult` frames and calls
/// `route_control_result`); this type is just the writer the server forwards
/// `Control` envelopes to.
pub type ControllerWriter = Arc<Mutex<std::os::unix::net::UnixStream>>;

#[derive(Default)]
pub struct Registry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    socket_path: PathBuf,
    agent_statuses: Mutex<HashMap<AgentKey, AgentReportPayload>>,
    agent_subscribers: Mutex<Vec<Sender<EventFrame>>>,
    // `Arc`-wrapped (rather than a bare `Mutex`) so a watcher's own callback
    // can hold a handle back to this map and remove its own entry once its
    // last subscriber disconnects — see `start_file_watcher`.
    file_watchers: Arc<Mutex<HashMap<String, WorktreeFileWatch>>>,
    /// The single registered controller (the GUI app). `None` while the app is
    /// offline; on reconnect the new writer replaces the old one.
    controller: Mutex<Option<ControllerWriter>>,
    /// In-flight brokered control requests keyed by `request_id`, each waiting
    /// for the controller's `ControlResult` reply.
    pending: Mutex<HashMap<String, Sender<ControlResult>>>,
}

type AgentKey = (String, String, String);

/// One live filesystem watcher for a worktree plus the set of subscribers it
/// fans changes out to. Both the watcher and the subscriber list are shared
/// (`Arc`) so the watcher's background callback can broadcast without holding
/// the registry lock.
struct WorktreeFileWatch {
    subscribers: Arc<Mutex<Vec<Sender<EventFrame>>>>,
    /// The trusted absolute path the watcher is rooted at, so a worktree
    /// deletion (`kill_for_cwd`) can find and tear down the matching watcher.
    root: String,
    // Kept alive for the worktree's watch lifetime; dropping it stops watching.
    _watcher: WorktreeWatcher,
}

impl Registry {
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            socket_path,
            agent_statuses: Mutex::new(HashMap::new()),
            agent_subscribers: Mutex::new(Vec::new()),
            file_watchers: Arc::new(Mutex::new(HashMap::new())),
            controller: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn spawn(
        &self,
        session_id: String,
        worktree_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), RegistryError> {
        // Reject duplicates before the expensive PTY open, but spawn the shell
        // outside the registry lock so concurrent writes/resizes/attaches to other
        // sessions are not serialized behind a blocking openpty + fork.
        if self
            .sessions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?
            .contains_key(&session_id)
        {
            return Err(RegistryError::AlreadyExists(session_id));
        }
        let session = Session::spawn(
            session_id.clone(),
            worktree_id,
            cwd,
            cols,
            rows,
            self.socket_path.to_string_lossy().into_owned(),
        )?;
        let attach = session.attach()?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        if sessions.contains_key(&session_id) {
            // Lost a race with a concurrent spawn of the same id; drop ours.
            session.kill()?;
            return Err(RegistryError::AlreadyExists(session_id));
        }
        sessions.insert(session_id, session);
        Ok(attach)
    }

    pub fn attach(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), RegistryError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| RegistryError::NotFound(session_id.to_string()))?;
        session.resize(cols, rows)?;
        Ok(session.attach()?)
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), RegistryError> {
        self.session(session_id)?.write(data)?;
        Ok(())
    }

    pub fn write_bytes(&self, session_id: &str, data: &[u8]) -> Result<(), RegistryError> {
        self.session(session_id)?.write_bytes(data)?;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), RegistryError> {
        self.session(session_id)?.resize(cols, rows)?;
        Ok(())
    }

    pub fn kill(&self, session_id: &str) -> Result<(), RegistryError> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?
            .remove(session_id)
            .ok_or_else(|| RegistryError::NotFound(session_id.to_string()))?;
        session.kill()?;
        self.clear_agents_for_tab(session_id);
        Ok(())
    }

    /// Kills every session whose initial cwd matches `path` exactly OR lives
    /// underneath it. Returns the number of sessions terminated; missing
    /// sessions are skipped so this is idempotent.
    pub fn kill_for_cwd(&self, path: &str) -> Result<usize, RegistryError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        let target_ids: Vec<String> = sessions
            .iter()
            .filter_map(|(id, session)| {
                let cwd = session.cwd();
                if cwd == path || cwd.starts_with(format!("{path}/").as_str()) {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        let mut killed = 0;
        for id in &target_ids {
            let Some(session) = sessions.get(id).cloned() else {
                continue;
            };
            // Only stop tracking a session once it is actually dead. Removing it
            // first and ignoring a kill failure would orphan a still-running
            // shell in a deleted worktree with no way to reach it again.
            if session.kill().is_ok() {
                sessions.remove(id);
                self.clear_agents_for_tab(id);
                killed += 1;
            }
        }
        drop(sessions);
        self.remove_file_watchers_for_cwd(path);
        Ok(killed)
    }

    /// Drops a session from the registry once its process has exited on its
    /// own (a `Kill` request never happened). Called from the server's event
    /// forwarder when it observes the session's `Exit` frame, so the
    /// `Session` — and the PTY master fd + scrollback memory it holds —
    /// doesn't outlive the shell process it wrapped. Unlike [`Self::kill`],
    /// the process is already reaped by the session's own reader thread, so
    /// this only needs to drop our reference.
    pub fn remove_exited(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
        self.clear_agents_for_tab(session_id);
    }

    pub fn report_agent(&self, payload: AgentReportPayload) -> Result<(), RegistryError> {
        let event = agent_event(&payload);
        let key = (
            payload.worktree_id.clone(),
            payload.tab_id.clone(),
            payload.agent.clone(),
        );
        let mut statuses = self
            .agent_statuses
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        // `cleared` is a transient removal signal, not a stored state: drop the
        // entry so a reconnecting subscriber's snapshot omits it, then broadcast
        // the cleared event so live subscribers remove their indicator.
        if matches!(payload.status, AgentStatus::Cleared) {
            statuses.remove(&key);
        } else {
            statuses.insert(key, payload);
        }
        drop(statuses);
        self.broadcast_agent(&event);
        Ok(())
    }

    pub fn subscribe_agents(
        &self,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), RegistryError> {
        let statuses = self
            .agent_statuses
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        let (tx, rx) = mpsc::channel();
        self.agent_subscribers
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?
            .push(tx);
        Ok((statuses.values().map(agent_event).collect(), rx))
    }

    /// Subscribes to filesystem changes under a worktree, lazily starting (and
    /// reusing) one recursive watcher per `worktree_id`. `root` is the trusted
    /// absolute worktree path supplied by the host client. Returns an empty
    /// snapshot (file changes are deltas only) and the delta receiver.
    pub fn subscribe_files(
        &self,
        worktree_id: String,
        root: &str,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), RegistryError> {
        let (tx, rx) = mpsc::channel();
        let mut watchers = self
            .file_watchers
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        if let Some(watch) = watchers.get(&worktree_id) {
            watch
                .subscribers
                .lock()
                .map_err(|_| RegistryError::LockPoisoned)?
                .push(tx);
        } else {
            let subscribers: Arc<Mutex<Vec<Sender<EventFrame>>>> = Arc::new(Mutex::new(vec![tx]));
            let watcher = Self::start_file_watcher(
                &worktree_id,
                root,
                Arc::clone(&subscribers),
                Arc::clone(&self.file_watchers),
            )?;
            watchers.insert(
                worktree_id,
                WorktreeFileWatch {
                    subscribers,
                    root: root.to_string(),
                    _watcher: watcher,
                },
            );
        }
        Ok((
            vec![EventFrame::Snapshot {
                subscription: ProtocolEventKind::FileChanged,
                payload: serde_json::Value::Array(Vec::new()),
            }],
            rx,
        ))
    }

    /// Builds a watcher whose callback broadcasts each batch of changes to the
    /// worktree's subscribers, pruning any that have disconnected. When a
    /// batch prunes the subscriber list to empty, the watcher also removes
    /// its own entry from `file_watchers` — otherwise a worktree that is
    /// never explicitly torn down via [`Self::kill_for_cwd`] (its tab closed
    /// without the worktree itself being deleted) would keep its recursive
    /// OS-level watch (an inotify watch group on Linux, a limited per-user
    /// kernel resource) running for the rest of the server's life.
    fn start_file_watcher(
        worktree_id: &str,
        root: &str,
        subscribers: Arc<Mutex<Vec<Sender<EventFrame>>>>,
        file_watchers: Arc<Mutex<HashMap<String, WorktreeFileWatch>>>,
    ) -> Result<WorktreeWatcher, RegistryError> {
        let worktree_id = worktree_id.to_string();
        WorktreeWatcher::new(Path::new(root), move |changes| {
            let Ok(mut subscribers) = subscribers.lock() else {
                return;
            };
            for change in changes {
                let Ok(payload) = serde_json::to_value(&change) else {
                    continue;
                };
                let event = EventFrame::Delta {
                    subscription: ProtocolEventKind::FileChanged,
                    payload: serde_json::json!({
                        "worktreeId": worktree_id,
                        "change": payload,
                    }),
                };
                subscribers.retain(|tx| tx.send(event.clone()).is_ok());
            }
            if subscribers.is_empty() {
                let file_watchers = Arc::clone(&file_watchers);
                let worktree_id = worktree_id.clone();
                // Tear the watcher down from a fresh thread rather than here:
                // this closure runs on the debouncer's own background thread,
                // and dropping the `WorktreeWatcher` (which owns that
                // debouncer) from inside its own callback risks the drop
                // trying to join a thread that is, transitively, itself.
                thread::spawn(move || {
                    if let Ok(mut watchers) = file_watchers.lock() {
                        watchers.remove(&worktree_id);
                    }
                });
            }
        })
        .map_err(|err| RegistryError::Watcher(err.to_string()))
    }

    /// Removes any filesystem watcher rooted at `path` or a descendant of it.
    /// Called alongside session teardown in [`Self::kill_for_cwd`] so a
    /// deleted worktree's watch doesn't outlive the directory it watches even
    /// when no further filesystem events ever arrive to trigger the reactive
    /// cleanup in [`Self::start_file_watcher`].
    fn remove_file_watchers_for_cwd(&self, path: &str) {
        if let Ok(mut watchers) = self.file_watchers.lock() {
            watchers.retain(|_, watch| {
                watch.root != path && !watch.root.starts_with(format!("{path}/").as_str())
            });
        }
    }

    pub fn clear_agents_for_tab(&self, tab_id: &str) {
        if let Ok(mut statuses) = self.agent_statuses.lock() {
            statuses.retain(|(_, status_tab_id, _), _| status_tab_id != tab_id);
        }
    }

    /// Drops a tab's resolved (`done`) agent statuses once the user has viewed
    /// the tab, so the server stops replaying them on the next subscriber
    /// reconnect. `running`/`attention` are kept — they persist until the agent
    /// itself moves on. Unlike a `cleared` report this does **not** broadcast: the
    /// viewing client has already dropped the green dot locally, so the sole
    /// purpose here is to keep a *seen* `done` out of future snapshots.
    pub fn mark_agents_seen_for_tab(&self, tab_id: &str) {
        if let Ok(mut statuses) = self.agent_statuses.lock() {
            statuses.retain(|(_, status_tab_id, _), payload| {
                status_tab_id != tab_id || !matches!(payload.status, AgentStatus::Done)
            });
        }
    }

    fn session(&self, session_id: &str) -> Result<Arc<Session>, RegistryError> {
        self.sessions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?
            .get(session_id)
            .cloned()
            .ok_or_else(|| RegistryError::NotFound(session_id.to_string()))
    }

    /// Registers the calling connection as the single controller (the GUI app).
    /// Replaces any previously-registered controller and fails every in-flight
    /// request still waiting on the old one. The controller's `ControlResult`
    /// replies are read on its own connection thread in the server and routed
    /// via [`Self::route_control_result`].
    pub fn register_controller(&self, writer: ControllerWriter) -> Result<(), RegistryError> {
        let mut controller = self
            .controller
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        let replaced = controller.is_some();
        *controller = Some(writer);
        drop(controller);
        if replaced {
            self.fail_pending();
        }
        Ok(())
    }

    /// Returns a clone of the controller writer, or `None` when no app is
    /// registered. The CLI fails fast with a "Pragma is not running" error in
    /// that case.
    pub fn controller_writer(&self) -> Result<Option<ControllerWriter>, RegistryError> {
        Ok(self
            .controller
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?
            .as_ref()
            .map(Arc::clone))
    }

    /// Inserts a pending control waiter keyed by `request_id`. A
    /// [`Registry::route_control_result`] call with the same id will deliver the
    /// reply to the returned receiver.
    pub fn pending_control(
        &self,
        request_id: String,
    ) -> Result<Receiver<ControlResult>, RegistryError> {
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?
            .insert(request_id, tx);
        Ok(rx)
    }

    /// Routes a controller reply to the waiting CLI waiter by `request_id`.
    /// No-op when the waiter has already dropped (timed out / disconnected).
    pub fn route_control_result(&self, request_id: &str, result: ControlResult) {
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(sender) = pending.remove(request_id) {
                let _ = sender.send(result);
            }
        }
    }

    /// Fails every in-flight pending request with an error message — used when
    /// the controller drops or the server shuts down so the CLI never hangs.
    fn fail_pending(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            let waiters = std::mem::take(&mut *pending);
            for (_id, sender) in waiters {
                let _ = sender.send(ControlResult {
                    ok: false,
                    payload: None,
                    error: Some("controller disconnected; request aborted".to_string()),
                });
            }
        }
    }

    /// Clears the controller entry when its connection drops.
    pub fn clear_controller(&self) {
        if let Ok(mut controller) = self.controller.lock() {
            *controller = None;
        }
        self.fail_pending();
    }

    /// Cancels a pending request when its CLI connection drops before the
    /// reply arrives, so the server does not hold a dangling waiter.
    pub fn cancel_pending(&self, request_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(request_id);
        }
    }

    #[cfg(test)]
    fn is_empty(&self) -> bool {
        self.sessions
            .lock()
            .is_ok_and(|sessions| sessions.is_empty())
    }

    #[cfg(test)]
    fn file_watcher_count(&self) -> usize {
        self.file_watchers
            .lock()
            .map_or(0, |watchers| watchers.len())
    }

    fn broadcast_agent(&self, event: &EventFrame) {
        if let Ok(mut subscribers) = self.agent_subscribers.lock() {
            subscribers.retain(|tx| tx.send(event.clone()).is_ok());
        }
    }
}

fn agent_event(payload: &AgentReportPayload) -> EventFrame {
    EventFrame::Agent {
        worktree_id: payload.worktree_id.clone(),
        tab_id: payload.tab_id.clone(),
        agent: payload.agent.clone(),
        status: payload.status,
        attention_kind: payload.attention_kind,
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::sync::{Arc, Mutex};

    use pragma_protocol::{AgentReportPayload, AgentStatus, ControlResult};
    use tempfile::tempdir;

    use super::Registry;

    fn agent_payload(status: AgentStatus) -> AgentReportPayload {
        AgentReportPayload {
            agent: "opencode".to_string(),
            worktree_id: "worktree-1".to_string(),
            tab_id: "tab-1".to_string(),
            status,
            attention_kind: None,
        }
    }

    #[test]
    fn cleared_report_removes_the_stored_status() {
        let registry = Registry::default();
        registry
            .report_agent(agent_payload(AgentStatus::Running))
            .expect("running report should store");
        let (before, _rx) = registry.subscribe_agents().expect("subscribe");
        assert_eq!(before.len(), 1, "running status should be in the snapshot");

        registry
            .report_agent(agent_payload(AgentStatus::Cleared))
            .expect("cleared report should remove");
        let (after, _rx) = registry.subscribe_agents().expect("subscribe");
        assert!(
            after.is_empty(),
            "cleared status must not linger in the snapshot"
        );
    }

    #[test]
    fn mark_seen_drops_only_done_statuses_for_the_tab() {
        let registry = Registry::default();
        let payload = |tab: &str, agent: &str, status| AgentReportPayload {
            agent: agent.to_string(),
            worktree_id: "worktree-1".to_string(),
            tab_id: tab.to_string(),
            status,
            attention_kind: None,
        };
        registry
            .report_agent(payload("tab-1", "opencode", AgentStatus::Done))
            .expect("done report should store");
        registry
            .report_agent(payload("tab-1", "codex", AgentStatus::Running))
            .expect("running report should store");
        registry
            .report_agent(payload("tab-2", "opencode", AgentStatus::Done))
            .expect("other tab done should store");

        registry.mark_agents_seen_for_tab("tab-1");

        let (snapshot, _rx) = registry.subscribe_agents().expect("subscribe");
        let mut remaining: Vec<(String, AgentStatus)> = snapshot
            .into_iter()
            .filter_map(|event| match event {
                pragma_protocol::EventFrame::Agent { tab_id, status, .. } => Some((tab_id, status)),
                _ => None,
            })
            .collect();
        remaining.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            remaining,
            vec![
                ("tab-1".to_string(), AgentStatus::Running),
                ("tab-2".to_string(), AgentStatus::Done),
            ],
            "only tab-1's done is dropped; its running and other tabs survive"
        );
    }

    /// Spawns a fresh PTY session in a real temp directory and returns the
    /// registry, the session id, and the tempdir (so its cwd stays alive for
    /// the duration of the test).
    fn spawn_session() -> (Registry, String, tempfile::TempDir) {
        let dir = tempdir().expect("tempdir");
        // Some shells refuse to start outside a real directory; tempdir gives
        // us one but it has to be a directory the kernel accepts.
        let _ = Command::new("true").output();
        let registry = Registry::default();
        let id = "session-1".to_string();
        let cwd = dir.path().to_string_lossy().into_owned();
        let (_scrollback, _rx) = registry
            .spawn(id.clone(), "worktree-1".to_string(), cwd, 80, 24)
            .expect("session should spawn");
        (registry, id, dir)
    }

    #[test]
    fn kill_for_cwd_terminates_matching_sessions_and_leaves_others() {
        let (registry, id, dir) = spawn_session();
        let cwd = dir.path().to_string_lossy().into_owned();
        let killed = registry.kill_for_cwd(&cwd).expect("kill should succeed");
        assert_eq!(killed, 1);
        // Subsequent attempts are idempotent — the session is gone.
        let killed_again = registry.kill_for_cwd(&cwd).expect("kill should succeed");
        assert_eq!(killed_again, 0);
        assert!(registry.is_empty(), "registry should be empty after kill");
        let _ = id;
    }

    #[test]
    fn kill_for_cwd_does_not_match_unrelated_paths() {
        let (registry, _id, _dir) = spawn_session();
        let killed = registry
            .kill_for_cwd("/some/other/place")
            .expect("kill should succeed");
        assert_eq!(killed, 0);
        assert!(!registry.is_empty());
    }

    /// Regression test for a filesystem-watcher leak: watchers were only ever
    /// inserted into `file_watchers`, never removed, so a worktree's watch
    /// outlived the worktree itself once it was deleted.
    #[test]
    fn kill_for_cwd_removes_the_matching_file_watcher() {
        let dir = tempdir().expect("tempdir");
        let registry = Registry::default();
        let root = dir.path().to_string_lossy().into_owned();
        let _stream = registry
            .subscribe_files("worktree-1".to_string(), &root)
            .expect("subscribe_files should succeed");
        assert_eq!(registry.file_watcher_count(), 1);

        registry
            .kill_for_cwd(&root)
            .expect("kill_for_cwd should succeed");

        assert_eq!(
            registry.file_watcher_count(),
            0,
            "watcher should be torn down along with its worktree"
        );
    }

    /// Regression test for the same leak in the more common case: a worktree
    /// tab is closed (its subscriber disconnects) without the worktree itself
    /// ever being deleted, so `kill_for_cwd` never runs. The watcher must
    /// still tear itself down reactively once its last subscriber is gone.
    #[test]
    fn watcher_is_torn_down_once_its_last_subscriber_disconnects() {
        let dir = tempdir().expect("tempdir");
        let registry = Registry::default();
        let root = dir.path().to_string_lossy().into_owned();
        let (_scrollback, rx) = registry
            .subscribe_files("worktree-1".to_string(), &root)
            .expect("subscribe_files should succeed");
        drop(rx);

        std::fs::write(dir.path().join("hello.txt"), "hi").expect("write file");

        let mut torn_down = false;
        for _ in 0..100 {
            if registry.file_watcher_count() == 0 {
                torn_down = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(
            torn_down,
            "watcher should be removed once its last subscriber disconnects"
        );
    }

    /// Registers a controller using a throwaway socketpair writer so tests can
    /// drive the broker without a real connection. Returns nothing — test code
    /// simulates the controller replying by calling `route_control_result`.
    fn register_fake_controller(registry: &Registry) {
        let (a, _b) =
            std::os::unix::net::UnixStream::pair().expect("socketpair for fake controller");
        let writer = Arc::new(Mutex::new(a));
        registry
            .register_controller(writer)
            .expect("register controller");
    }

    #[test]
    fn control_result_routes_back_by_request_id() {
        let registry = Registry::default();
        register_fake_controller(&registry);
        let rx = registry
            .pending_control("req-1".to_string())
            .expect("pending waiter");
        registry.route_control_result(
            "req-1",
            ControlResult {
                ok: true,
                payload: Some(serde_json::json!({ "ok": true })),
                error: None,
            },
        );
        let result = rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("result routed");
        assert!(result.ok);
        assert_eq!(result.payload, Some(serde_json::json!({ "ok": true })));
    }

    #[test]
    fn control_result_for_unknown_id_is_dropped() {
        let registry = Registry::default();
        register_fake_controller(&registry);
        let _rx = registry
            .pending_control("req-2".to_string())
            .expect("pending waiter");
        // A late/wrong reply is a no-op.
        registry.route_control_result(
            "not-known",
            ControlResult {
                ok: true,
                payload: None,
                error: None,
            },
        );
        // No deadlock / no panic; the pending entry is still there until cancelled.
        registry.cancel_pending("req-2");
    }

    /// Regression test for a session leak: a session whose process exited on
    /// its own (no `Kill` request) used to stay in the registry forever,
    /// leaking its PTY master fd and scrollback. `remove_exited` is what the
    /// server's event forwarder calls on an `Exit` frame to close that gap.
    #[test]
    fn remove_exited_drops_the_session_and_its_agent_status() {
        let (registry, id, _dir) = spawn_session();
        registry
            .report_agent(AgentReportPayload {
                agent: "opencode".to_string(),
                worktree_id: "worktree-1".to_string(),
                tab_id: id.clone(),
                status: AgentStatus::Running,
                attention_kind: None,
            })
            .expect("report agent");

        registry.remove_exited(&id);

        assert!(
            registry.is_empty(),
            "session should be removed once its process exits on its own"
        );
        let (snapshot, _rx) = registry.subscribe_agents().expect("subscribe");
        assert!(
            snapshot.is_empty(),
            "agent status for the exited tab should be cleared too"
        );
    }

    #[test]
    fn no_controller_is_reported_when_app_offline() {
        let registry = Registry::default();
        let writer = registry.controller_writer().expect("controller_writer");
        assert!(writer.is_none(), "no controller should be registered");
    }

    #[test]
    fn controller_reconnect_replaces_writer() {
        let registry = Registry::default();
        register_fake_controller(&registry);
        // Old waiter from the replaced controller must be failed.
        let rx = registry
            .pending_control("req-old".to_string())
            .expect("pending waiter");
        register_fake_controller(&registry);
        let result = rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("old waiter failed on replace");
        assert!(!result.ok);
        assert!(result.error.is_some());
        // The new controller is now live.
        assert!(registry
            .controller_writer()
            .expect("controller_writer")
            .is_some());
    }
}
