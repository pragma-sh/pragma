use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use pragma_constants::{
    AgentSessionLaunchPayload, NewWorktreeSpec, ProtocolEventKind, Tab, TabKind, Worktree,
};
use pragma_core::git::GitRequest;
use pragma_core::watcher::WorktreeWatcher;
use pragma_protocol::{
    AgentAnswer, AgentDecision, AgentInput, AgentInterrupt, AgentMessage, AgentReportPayload,
    AgentStatus, ControlResult, EventFrame, WorkspaceSnapshot,
};
use serde_json::{json, Value};
use thiserror::Error;
use uuid::Uuid;

use crate::automations::{AutomationError, AutomationsRegistry};
use crate::plugins_host::{PluginsError, PluginsRegistry};
use crate::session::{Session, SessionError};
use crate::tunnel::{TunnelError, TunnelRegistry};

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

/// File beside `daemon.sock` holding the last published workspace snapshot.
/// Persisted so controller-free (headless) agent launches keep working after
/// the server restarts while the desktop app stays closed.
const WORKSPACE_SNAPSHOT_FILE: &str = "workspace.json";

const AGENT_DECISION_REPLAY_WINDOW: Duration = Duration::from_secs(5);
const AGENT_DECISION_REPLAY_LIMIT: usize = 64;
/// Newest chat messages retained per agent session for subscriber replay, so a
/// client attaching mid-session (a paired phone opening a chat) sees the
/// conversation so far instead of an empty transcript.
const AGENT_MESSAGE_REPLAY_LIMIT: usize = 200;
pub struct Registry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    socket_path: PathBuf,
    /// Directory beside the socket where server-owned state (the persisted
    /// workspace snapshot) lives.
    server_dir: PathBuf,
    agent_statuses: Mutex<HashMap<AgentKey, AgentReportPayload>>,
    recent_agent_decisions: Mutex<Vec<RecentAgentDecision>>,
    recent_agent_answers: Mutex<Vec<RecentAgentAnswer>>,
    /// Chat-message history per live agent session (bounded, newest kept),
    /// replayed to new agent subscribers. Dropped with the session's tab.
    recent_agent_messages: Mutex<HashMap<AgentKey, Vec<AgentMessage>>>,
    agent_subscribers: Mutex<Vec<Sender<EventFrame>>>,
    /// Subscribers to durable agent-status snapshots for generic protocol clients.
    agent_status_subscribers: Mutex<Vec<Sender<EventFrame>>>,
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
    /// Latest workspace mirror the desktop app published (projects/worktrees/tabs).
    /// Cached so a remote subscriber (e.g. a paired phone) attaching just after a
    /// publish still gets the current state as its snapshot.
    workspace: Mutex<Option<WorkspaceSnapshot>>,
    /// Subscribers to the workspace snapshot-then-delta stream. A publish replaces
    /// the snapshot and fans a full-snapshot `Delta` to all live subscribers; v1
    /// keeps deltas trivial (every delta is a full replacement).
    workspace_subscribers: Mutex<Vec<Sender<EventFrame>>>,
    automations: Arc<AutomationsRegistry>,
    plugins: Arc<PluginsRegistry>,
    tunnel: Arc<TunnelRegistry>,
}

type AgentKey = (String, String, String);

fn optional_str(value: &Value) -> Option<&str> {
    if value.is_null() {
        None
    } else {
        value.as_str()
    }
}

/// Reads the persisted workspace snapshot from `server_dir`, or `None` when no
/// snapshot has ever been published (or the file is unreadable/corrupt — a
/// stale mirror is strictly worse than an empty one the desktop republishes).
fn load_workspace_snapshot(server_dir: &Path) -> Option<WorkspaceSnapshot> {
    let contents = std::fs::read_to_string(server_dir.join(WORKSPACE_SNAPSHOT_FILE)).ok()?;
    serde_json::from_str(&contents).ok()
}

/// Persists the workspace snapshot beside the socket. Best-effort: a failed
/// write only costs headless launches after a future server restart.
fn persist_workspace_snapshot(server_dir: &Path, snapshot: &WorkspaceSnapshot) {
    let Ok(contents) = serde_json::to_string(snapshot) else {
        return;
    };
    if let Err(error) = std::fs::write(server_dir.join(WORKSPACE_SNAPSHOT_FILE), contents) {
        eprintln!("failed to persist workspace snapshot: {error}");
    }
}

/// Runs one `pragma-core` git operation locally (the same operations the
/// desktop routes through host RPC), mapping failures to launch errors.
fn run_core_git(request: &GitRequest) -> Result<(), String> {
    let payload = serde_json::to_value(request).map_err(|error| error.to_string())?;
    pragma_core::git::handle(payload)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// UTC timestamp in the `YYYY-MM-DD HH:MM:SS` format the desktop's `SQLite`
/// rows use, so headless-created snapshot rows sort alongside DB-created ones.
fn now_timestamp() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_./:=@+-".contains(&byte))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn schedule_agent_launch(session: &Session, launch: &Value, command: &str, prompt: Option<&str>) {
    thread::sleep(Duration::from_millis(
        pragma_constants::CONSTANTS.agents.start_delay_ms,
    ));
    let _ = session.write(&format!("{command}\r"));
    let mut elapsed_ms = 0;
    for input in launch["startupInput"].as_array().into_iter().flatten() {
        let delay_ms = input["delayMs"].as_u64().unwrap_or(0);
        thread::sleep(Duration::from_millis(delay_ms.saturating_sub(elapsed_ms)));
        elapsed_ms = elapsed_ms.max(delay_ms);
        if let Some(data) = input["data"].as_str() {
            let _ = session.write(data);
        }
    }
    let Some(prompt) = prompt.filter(|prompt| !prompt.trim().is_empty()) else {
        return;
    };
    let prefill_delay_ms = launch["prefillDelayMs"].as_u64().unwrap_or(2_500);
    thread::sleep(Duration::from_millis(
        prefill_delay_ms.saturating_sub(elapsed_ms),
    ));
    let body = if launch["prefillMode"] == "plain" {
        prompt.to_string()
    } else {
        format!("\u{1b}[200~{prompt}\u{1b}[201~")
    };
    let _ = session.write(&body);
    thread::sleep(Duration::from_millis(
        launch["prefillSubmitDelayMs"].as_u64().unwrap_or(200),
    ));
    let _ = session.write(launch["prefillSubmit"].as_str().unwrap_or("\r"));
}

struct RecentAgentDecision {
    decision: AgentDecision,
    recorded_at: Instant,
}

struct RecentAgentAnswer {
    answer: AgentAnswer,
    recorded_at: Instant,
}

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

fn prune_agent_decisions(decisions: &mut Vec<RecentAgentDecision>) {
    decisions.retain(|entry| entry.recorded_at.elapsed() <= AGENT_DECISION_REPLAY_WINDOW);
}

fn prune_agent_answers(answers: &mut Vec<RecentAgentAnswer>) {
    answers.retain(|entry| entry.recorded_at.elapsed() <= AGENT_DECISION_REPLAY_WINDOW);
}

impl Registry {
    pub fn new(socket_path: PathBuf, server_dir: PathBuf, _workspace_root: PathBuf) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            socket_path,
            agent_statuses: Mutex::new(HashMap::new()),
            recent_agent_decisions: Mutex::new(Vec::new()),
            recent_agent_answers: Mutex::new(Vec::new()),
            recent_agent_messages: Mutex::new(HashMap::new()),
            agent_subscribers: Mutex::new(Vec::new()),
            agent_status_subscribers: Mutex::new(Vec::new()),
            file_watchers: Arc::new(Mutex::new(HashMap::new())),
            controller: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            workspace: Mutex::new(load_workspace_snapshot(&server_dir)),
            workspace_subscribers: Mutex::new(Vec::new()),
            automations: AutomationsRegistry::new(server_dir.clone()),
            plugins: PluginsRegistry::new(server_dir.clone()),
            tunnel: TunnelRegistry::new(server_dir.clone()),
            server_dir,
        }
    }

    pub fn handle_tunnel_rpc(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, TunnelError> {
        self.tunnel.handle_rpc(payload)
    }

    /// Routes a `plugins` RPC (catalog, registerRoots, readAsset, reload) to the
    /// plugin catalog host.
    pub fn handle_plugins_rpc(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, PluginsError> {
        self.plugins.handle_rpc(payload)
    }

    pub fn handle_automation_rpc(
        &self,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, AutomationError> {
        self.automations.handle_rpc(payload)
    }

    pub fn subscribe_automation_pending(
        &self,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), AutomationError> {
        self.automations.subscribe_pending()
    }

    pub fn subscribe_automations_changed(
        &self,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), AutomationError> {
        self.automations.subscribe_changed()
    }

    /// Stores the latest workspace mirror and fans a `Delta` carrying the full
    /// replacement snapshot to all live subscribers. v1 keeps deltas trivial
    /// (the delta is the whole snapshot); row-level deltas are a later
    /// optimization. Mirrors `broadcast_agent`: dead subscribers are pruned.
    pub fn publish_workspace(&self, snapshot: WorkspaceSnapshot) {
        let payload = serde_json::to_value(&snapshot).unwrap_or(serde_json::Value::Null);
        persist_workspace_snapshot(&self.server_dir, &snapshot);
        if let Ok(mut guard) = self.workspace.lock() {
            *guard = Some(snapshot);
        }
        self.broadcast_workspace(&EventFrame::Delta {
            subscription: ProtocolEventKind::Workspace,
            payload,
        });
    }

    /// Applies a server-originated mutation (a headless launch creating a
    /// worktree/tab) to the mirrored snapshot, persists it, and fans the full
    /// replacement out to workspace subscribers — so a paired phone sees the
    /// new rows immediately even though the desktop app is closed. The desktop
    /// remains the source of truth: its next publish replaces this snapshot
    /// (it adopts headless worktrees from disk before publishing).
    fn mutate_workspace(&self, mutate: impl FnOnce(&mut WorkspaceSnapshot)) -> Result<(), String> {
        let payload = {
            let mut guard = self
                .workspace
                .lock()
                .map_err(|_| "workspace lock poisoned".to_string())?;
            let snapshot = guard
                .as_mut()
                .ok_or_else(|| "desktop has not published a workspace snapshot".to_string())?;
            mutate(snapshot);
            persist_workspace_snapshot(&self.server_dir, snapshot);
            serde_json::to_value(&*snapshot).unwrap_or(serde_json::Value::Null)
        };
        self.broadcast_workspace(&EventFrame::Delta {
            subscription: ProtocolEventKind::Workspace,
            payload,
        });
        Ok(())
    }

    /// Launches an agent when no desktop controller is connected: resolves an
    /// existing mirrored worktree — or creates a fresh git worktree via
    /// `pragma-core` — spawns the PTY, schedules the agent's startup/prefill
    /// input, and merges the new worktree/tab into the mirrored snapshot so a
    /// paired phone sees them immediately. The desktop adopts headless-created
    /// worktrees from disk on its next publish.
    pub fn launch_agent_headless(&self, payload: Value) -> Result<Value, String> {
        let args: AgentSessionLaunchPayload =
            serde_json::from_value(payload).map_err(|error| error.to_string())?;
        let project_root = self.mirrored_project_path(&args.project_id)?;
        self.plugins
            .handle_rpc(&json!({ "action": "registerRoots", "roots": [project_root] }))
            .map_err(|error| error.to_string())?;
        let (worktree_id, cwd) = match (args.worktree_id, args.new_worktree) {
            (Some(_), Some(_)) => {
                return Err(
                    "agentSessionLaunch: provide either worktreeId or newWorktree, not both"
                        .to_string(),
                );
            }
            (None, None) => {
                return Err("agentSessionLaunch: worktreeId or newWorktree is required".to_string());
            }
            (Some(id), None) => {
                let cwd = self.mirrored_worktree_path(&args.project_id, &id)?;
                (id, cwd)
            }
            (None, Some(spec)) => self.create_worktree_headless(&args.project_id, &spec)?,
        };
        let (plugin_id, launch, command) = self.resolve_agent_launch(
            &args.agent_id,
            args.model_id.as_deref(),
            args.reasoning_id.as_deref(),
        )?;
        let tab_id = Uuid::new_v4().to_string();
        let _events = self
            .spawn(tab_id.clone(), worktree_id.clone(), cwd, 120, 40)
            .map_err(|error| error.to_string())?;
        let session = self
            .sessions
            .lock()
            .map_err(|_| "sessions lock poisoned".to_string())?
            .get(&tab_id)
            .cloned()
            .ok_or_else(|| "spawned session disappeared".to_string())?;
        crate::watchers::start_for_headless_launch(
            &self.plugins,
            &self.server_dir,
            Some(&plugin_id),
            &args.agent_id,
            &tab_id,
            &worktree_id,
        );
        let prompt = args.prompt;
        thread::spawn(move || {
            schedule_agent_launch(&session, &launch, &command, prompt.as_deref());
        });
        self.append_mirrored_tab(&args.project_id, &worktree_id, &tab_id);
        Ok(json!({ "worktreeId": worktree_id, "tabId": tab_id }))
    }

    fn mirrored_project_path(&self, project_id: &str) -> Result<String, String> {
        let workspace = self
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        workspace
            .as_ref()
            .and_then(|snapshot| {
                snapshot
                    .projects
                    .iter()
                    .find(|project| project.id == project_id)
            })
            .map(|project| project.path.clone())
            .ok_or_else(|| format!("project not found: {project_id}"))
    }

    /// Resolves an existing worktree's path from the mirrored snapshot.
    fn mirrored_worktree_path(
        &self,
        project_id: &str,
        worktree_id: &str,
    ) -> Result<String, String> {
        let workspace = self
            .workspace
            .lock()
            .map_err(|_| "workspace lock poisoned".to_string())?;
        let snapshot = workspace
            .as_ref()
            .ok_or_else(|| "desktop has not published a workspace snapshot".to_string())?;
        snapshot
            .worktrees
            .iter()
            .find(|worktree| worktree.id == worktree_id && worktree.project_id == project_id)
            .map(|worktree| worktree.path.clone())
            .ok_or_else(|| "worktree is not present in mirrored workspace".to_string())
    }

    /// Creates a fresh git worktree for a headless launch, mirroring the
    /// desktop's layout (`<project>/.pragma/worktrees/<uuid>`, new branch
    /// forked from the parent worktree) through the same `pragma-core` git
    /// operations, then merges it into the mirrored snapshot. Returns the new
    /// `(worktreeId, path)`.
    fn create_worktree_headless(
        &self,
        project_id: &str,
        spec: &NewWorktreeSpec,
    ) -> Result<(String, String), String> {
        let branch = spec.branch.trim();
        if branch.is_empty() {
            return Err("branch is required".to_string());
        }
        let (project_path, parent) = {
            let workspace = self
                .workspace
                .lock()
                .map_err(|_| "workspace lock poisoned".to_string())?;
            let snapshot = workspace
                .as_ref()
                .ok_or_else(|| "desktop has not published a workspace snapshot".to_string())?;
            let project_path = snapshot
                .projects
                .iter()
                .find(|project| project.id == project_id)
                .map(|project| project.path.clone())
                .ok_or_else(|| "project is not present in mirrored workspace".to_string())?;
            let parent = snapshot
                .worktrees
                .iter()
                .find(|worktree| {
                    worktree.id == spec.parent_worktree_id && worktree.project_id == project_id
                })
                .cloned()
                .ok_or_else(|| {
                    "parent worktree is not present in mirrored workspace".to_string()
                })?;
            (project_path, parent)
        };
        let worktree_id = Uuid::new_v4().to_string();
        let path = Path::new(&project_path)
            .join(".pragma/worktrees")
            .join(&worktree_id)
            .to_string_lossy()
            .into_owned();
        run_core_git(&GitRequest::EnsurePragmaExcluded {
            project_root: project_path,
        })?;
        run_core_git(&GitRequest::CreateWorktree {
            parent_root: parent.path,
            branch: branch.to_string(),
            path: path.clone(),
        })?;
        let worktree = Worktree {
            id: worktree_id.clone(),
            project_id: project_id.to_string(),
            parent_id: Some(parent.id),
            branch: branch.to_string(),
            title: spec
                .title
                .as_deref()
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_string),
            path: path.clone(),
            is_main: false,
            hidden: false,
            created_at: now_timestamp(),
        };
        self.mutate_workspace(|snapshot| snapshot.worktrees.push(worktree))?;
        Ok((worktree_id, path))
    }

    /// Merges the headless launch's terminal tab into the mirrored snapshot so
    /// remote subscribers can render it. Best-effort: the desktop's next
    /// publish replaces the snapshot with its own durable rows.
    fn append_mirrored_tab(&self, project_id: &str, worktree_id: &str, tab_id: &str) {
        let tab = Tab {
            id: tab_id.to_string(),
            project_id: project_id.to_string(),
            worktree_id: worktree_id.to_string(),
            kind: TabKind::Terminal,
            title: None,
            url: None,
            file_path: None,
            diff_side: None,
            pr_number: None,
            plugin_id: None,
            plugin_view_id: None,
            plugin_payload: None,
            plugin_dedupe_key: None,
            user_renamed: false,
            order_index: 0,
            created_at: now_timestamp(),
        };
        if let Err(error) = self.mutate_workspace(|snapshot| {
            let next_index = snapshot
                .tabs
                .iter()
                .filter(|existing| existing.worktree_id == worktree_id)
                .map(|existing| existing.order_index)
                .max()
                .map_or(0, |max| max + 1);
            snapshot.tabs.push(Tab {
                order_index: next_index,
                ..tab
            });
        }) {
            eprintln!("headless launch: failed to mirror tab {tab_id}: {error}");
        }
    }

    /// Resolves an agent's launch spec + shell command from the plugin catalog
    /// for the selected model/reasoning combination.
    fn resolve_agent_launch(
        &self,
        agent_id: &str,
        model_id: Option<&str>,
        reasoning_id: Option<&str>,
    ) -> Result<(String, Value, String), String> {
        let catalog = self
            .plugins
            .handle_rpc(&json!({ "action": "catalog" }))
            .map_err(|error| error.to_string())?;
        let agent = catalog["agents"]
            .as_array()
            .and_then(|agents| agents.iter().find(|agent| agent["id"] == agent_id))
            .ok_or_else(|| format!("agent not found: {agent_id}"))?;
        let command = agent["launch"]["commands"]
            .as_array()
            .and_then(|commands| {
                commands.iter().find(|command| {
                    optional_str(&command["modelId"]) == model_id
                        && optional_str(&command["reasoningId"]) == reasoning_id
                })
            })
            .and_then(|launch| launch["command"].as_array())
            .ok_or_else(|| "agent launch command does not match selected model".to_string())?
            .iter()
            .map(|part| {
                part.as_str()
                    .map(shell_quote)
                    .ok_or_else(|| "agent launch command contains non-string".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(" ");
        let plugin_id = agent["pluginId"]
            .as_str()
            .ok_or_else(|| "agent catalog entry has no plugin id".to_string())?
            .to_string();
        Ok((plugin_id, agent["launch"].clone(), command))
    }

    /// Subscribes to the workspace snapshot-then-delta stream. The snapshot is
    /// the cached mirror, or an empty payload when the desktop has not yet
    /// published. Mirrors `subscribe_agents`.
    pub fn subscribe_workspace(
        &self,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), RegistryError> {
        let (tx, rx) = mpsc::channel();
        // Lock the workspace snapshot first, then the subscriber list. This
        // matches the order used by `publish_workspace` (workspace ->
        // subscribers) and prevents a deadlock when a publish races with a new
        // subscription. The subscriber is added while the workspace guard is
        // still held so a concurrent publish cannot update the snapshot and
        // broadcast before this subscriber is registered.
        let snapshot = {
            let workspace = self
                .workspace
                .lock()
                .map_err(|_| RegistryError::LockPoisoned)?;
            let snapshot = workspace.as_ref().map_or_else(
                || serde_json::json!({ "projects": [], "worktrees": [], "tabs": [] }),
                |snapshot| serde_json::to_value(snapshot).unwrap_or(serde_json::Value::Null),
            );
            let mut subscribers = self
                .workspace_subscribers
                .lock()
                .map_err(|_| RegistryError::LockPoisoned)?;
            subscribers.push(tx);
            snapshot
        };
        Ok((
            vec![EventFrame::Snapshot {
                subscription: ProtocolEventKind::Workspace,
                payload: snapshot,
            }],
            rx,
        ))
    }

    /// Fans a delta event out to workspace subscribers, pruning any whose channel
    /// has gone away. Mirrors `broadcast_agent`.
    fn broadcast_workspace(&self, event: &EventFrame) {
        if let Ok(mut subscribers) = self.workspace_subscribers.lock() {
            subscribers.retain(|tx| tx.send(event.clone()).is_ok());
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
        let socket_path = self.socket_path.to_string_lossy();
        let session = Session::spawn(
            session_id.clone(),
            worktree_id,
            cwd,
            cols,
            rows,
            &socket_path,
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

    /// Attaches to a session's event stream. A `Some` size resizes the PTY to
    /// the attacher's viewport (an interactive client taking over the display);
    /// `None` attaches as a passive observer — e.g. a plugin watcher — without
    /// disturbing the size the interactive client already set.
    pub fn attach(
        &self,
        session_id: &str,
        size: Option<(u16, u16)>,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), RegistryError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| RegistryError::NotFound(session_id.to_string()))?;
        if let Some((cols, rows)) = size {
            session.resize(cols, rows)?;
        }
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
        // `cleared` is stored like every other status: it marks an idle-but-live
        // agent session (a fresh TUI before its first turn, or a finished one),
        // so a late subscriber — e.g. a paired phone's worktree list — still
        // sees that the session exists. Live subscribers keep treating the
        // broadcast `cleared` event as "remove the indicator". Entries are
        // removed when the hosting tab's session exits
        // ([`Self::clear_agents_for_tab`]).
        statuses.insert(key, payload);
        drop(statuses);
        self.broadcast_agent(&event);
        self.broadcast_agent_status()?;
        Ok(())
    }

    /// Subscribes to a snapshot-then-replacement stream of all live agent statuses.
    pub fn subscribe_agent_status(
        &self,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), RegistryError> {
        let (tx, rx) = mpsc::channel();
        let statuses = self
            .agent_statuses
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        let snapshot = serde_json::to_value(statuses.values().collect::<Vec<_>>())
            .unwrap_or(serde_json::Value::Null);
        self.agent_status_subscribers
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?
            .push(tx);
        Ok((
            vec![EventFrame::Snapshot {
                subscription: ProtocolEventKind::AgentStatus,
                payload: snapshot,
            }],
            rx,
        ))
    }

    /// Fans the complete live-status replacement so cleared reports remove stale inbox items.
    fn broadcast_agent_status(&self) -> Result<(), RegistryError> {
        let statuses = self
            .agent_statuses
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        let event = EventFrame::Delta {
            subscription: ProtocolEventKind::AgentStatus,
            payload: serde_json::to_value(statuses.values().collect::<Vec<_>>())
                .unwrap_or(serde_json::Value::Null),
        };
        drop(statuses);
        if let Ok(mut subscribers) = self.agent_status_subscribers.lock() {
            subscribers.retain(|tx| tx.send(event.clone()).is_ok());
        }
        Ok(())
    }

    /// Fans a chat message out to agent subscribers and appends it to the
    /// session's bounded replay buffer so late subscribers get the transcript.
    pub fn report_agent_message(&self, message: AgentMessage) {
        self.remember_agent_message(&message);
        self.broadcast_agent(&EventFrame::AgentMessage { message });
    }

    fn remember_agent_message(&self, message: &AgentMessage) {
        let Ok(mut messages) = self.recent_agent_messages.lock() else {
            return;
        };
        let key = (
            message.worktree_id.clone(),
            message.tab_id.clone(),
            message.agent.clone(),
        );
        let buffer = messages.entry(key).or_default();
        buffer.push(message.clone());
        let excess = buffer.len().saturating_sub(AGENT_MESSAGE_REPLAY_LIMIT);
        if excess > 0 {
            buffer.drain(..excess);
        }
    }

    /// Fans a free-form interjection out to agent subscribers. Desktop and
    /// headless launches both run watchers that own TUI-specific delivery.
    pub fn report_agent_input(&self, input: AgentInput) {
        self.broadcast_agent(&EventFrame::AgentInput { input });
    }

    /// Fans a transient interrupt out to agent subscribers. No replay buffer:
    /// interrupts are best-effort to live watchers, which are long-lived
    /// subscribers by the time a user interrupts a running agent.
    pub fn report_agent_interrupt(&self, interrupt: AgentInterrupt) {
        self.broadcast_agent(&EventFrame::AgentInterrupt { interrupt });
    }

    /// Fans a command-approval verdict out to agent subscribers. A short replay
    /// window covers watcher startup/subscription races after a toast click.
    pub fn report_agent_decision(&self, decision: AgentDecision) {
        self.remember_agent_decision(&decision);
        self.broadcast_agent(&EventFrame::AgentDecision { decision });
    }

    fn remember_agent_decision(&self, decision: &AgentDecision) {
        let Ok(mut decisions) = self.recent_agent_decisions.lock() else {
            return;
        };
        prune_agent_decisions(&mut decisions);
        decisions.push(RecentAgentDecision {
            decision: decision.clone(),
            recorded_at: Instant::now(),
        });
        let excess = decisions.len().saturating_sub(AGENT_DECISION_REPLAY_LIMIT);
        if excess > 0 {
            decisions.drain(..excess);
        }
    }

    /// Fans a question reply out to agent subscribers. A short replay window
    /// covers watcher startup/subscription races after a toast answer.
    pub fn report_agent_answer(&self, answer: AgentAnswer) {
        self.remember_agent_answer(&answer);
        self.broadcast_agent(&EventFrame::AgentAnswer { answer });
    }

    fn remember_agent_answer(&self, answer: &AgentAnswer) {
        let Ok(mut answers) = self.recent_agent_answers.lock() else {
            return;
        };
        prune_agent_answers(&mut answers);
        answers.push(RecentAgentAnswer {
            answer: answer.clone(),
            recorded_at: Instant::now(),
        });
        let excess = answers.len().saturating_sub(AGENT_DECISION_REPLAY_LIMIT);
        if excess > 0 {
            answers.drain(..excess);
        }
    }

    pub fn subscribe_agents(
        &self,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), RegistryError> {
        let statuses = self
            .agent_statuses
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        let mut decisions = self
            .recent_agent_decisions
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        prune_agent_decisions(&mut decisions);
        let mut answers = self
            .recent_agent_answers
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?;
        prune_agent_answers(&mut answers);
        let (tx, rx) = mpsc::channel();
        self.agent_subscribers
            .lock()
            .map_err(|_| RegistryError::LockPoisoned)?
            .push(tx);
        let mut snapshot: Vec<EventFrame> = statuses.values().map(agent_event).collect();
        snapshot.extend(decisions.iter().map(|entry| EventFrame::AgentDecision {
            decision: entry.decision.clone(),
        }));
        snapshot.extend(answers.iter().map(|entry| EventFrame::AgentAnswer {
            answer: entry.answer.clone(),
        }));
        if let Ok(messages) = self.recent_agent_messages.lock() {
            snapshot.extend(
                messages
                    .values()
                    .flatten()
                    .map(|message| EventFrame::AgentMessage {
                        message: message.clone(),
                    }),
            );
        }
        Ok((snapshot, rx))
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
                        // Re-check under the lock: a concurrent
                        // `subscribe_files` call may have added a new
                        // subscriber between when the callback saw the list
                        // empty and now, so only remove if it is still empty.
                        let still_empty = watchers
                            .get(&worktree_id)
                            .and_then(|w| w.subscribers.lock().ok())
                            .is_none_or(|subs| subs.is_empty());
                        if still_empty {
                            watchers.remove(&worktree_id);
                        }
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
        if let Ok(mut messages) = self.recent_agent_messages.lock() {
            messages.retain(|(_, message_tab_id, _), _| message_tab_id != tab_id);
        }
    }

    /// Downgrades a tab's resolved (`done`) agent statuses to `cleared` once the
    /// user has viewed the tab, so the server stops replaying the green dot on
    /// the next subscriber reconnect while the session itself stays listed as
    /// idle. `running`/`attention` are kept — they persist until the agent
    /// itself moves on. Unlike a `cleared` report this does **not** broadcast: the
    /// viewing client has already dropped the green dot locally, so the sole
    /// purpose here is to keep a *seen* `done` out of future snapshots.
    pub fn mark_agents_seen_for_tab(&self, tab_id: &str) {
        if let Ok(mut statuses) = self.agent_statuses.lock() {
            for ((_, status_tab_id, _), payload) in statuses.iter_mut() {
                if status_tab_id == tab_id && matches!(payload.status, AgentStatus::Done) {
                    payload.status = AgentStatus::Cleared;
                }
            }
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
        command: payload.command.clone(),
        question: payload.question.clone(),
        // typify models optional schema arrays as `Vec` (default empty); the
        // wire event keeps `Option` so absent options stay omitted on the wire.
        options: if payload.options.is_empty() {
            None
        } else {
            Some(payload.options.clone())
        },
        request_id: payload.request_id.clone(),
    }
}

#[cfg(test)]
impl Default for Registry {
    fn default() -> Self {
        let root = std::env::temp_dir().join(format!("pragma-server-test-{}", std::process::id()));
        Self::new(root.join("daemon.sock"), root, PathBuf::new())
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use pragma_constants::{NewWorktreeSpec, Project, Worktree};
    use pragma_protocol::{
        AgentAnswer, AgentDecision, AgentInput, AgentInterrupt, AgentMessage, AgentReportPayload,
        AgentStatus, ControlResult, EventFrame, WorkspaceSnapshot,
    };
    use tempfile::tempdir;

    use super::{RecentAgentAnswer, RecentAgentDecision, Registry, AGENT_DECISION_REPLAY_WINDOW};

    /// A registry rooted in its own private directory, so persistence tests do
    /// not bleed state through the process-wide `Default` directory.
    fn registry_in(dir: &std::path::Path) -> Registry {
        Registry::new(
            dir.join("daemon.sock"),
            dir.to_path_buf(),
            std::path::PathBuf::new(),
        )
    }

    fn snapshot_with_project(project_path: &str) -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            projects: vec![Project {
                id: "project-1".to_string(),
                name: "sandbox".to_string(),
                path: project_path.to_string(),
                order_index: 0,
                created_at: "2026-01-01 00:00:00".to_string(),
            }],
            worktrees: vec![Worktree {
                id: "worktree-main".to_string(),
                project_id: "project-1".to_string(),
                parent_id: None,
                branch: "main".to_string(),
                title: None,
                path: project_path.to_string(),
                is_main: true,
                hidden: false,
                created_at: "2026-01-01 00:00:00".to_string(),
            }],
            tabs: vec![],
        }
    }

    #[test]
    fn published_workspace_snapshot_survives_a_server_restart() {
        let dir = tempdir().expect("tempdir");
        let registry = registry_in(dir.path());
        registry.publish_workspace(snapshot_with_project("/tmp/sandbox"));
        drop(registry);

        let reloaded = registry_in(dir.path());
        let (snapshot, _rx) = reloaded.subscribe_workspace().expect("subscribe");
        let payload = match snapshot.first() {
            Some(EventFrame::Snapshot { payload, .. }) => payload.clone(),
            other => panic!("expected snapshot frame, got {other:?}"),
        };
        assert_eq!(payload["projects"][0]["id"], "project-1");
        assert_eq!(payload["worktrees"][0]["id"], "worktree-main");
    }

    #[test]
    fn headless_new_worktree_creates_a_git_checkout_and_mirrors_it() {
        let repo = tempdir().expect("repo dir");
        let run = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(repo.path())
                .args(args)
                .output()
                .expect("git runs");
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(&["init", "-b", "main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        std::fs::write(repo.path().join("README.md"), "hello").expect("write file");
        run(&["add", "."]);
        run(&["commit", "-m", "init"]);

        let server_dir = tempdir().expect("server dir");
        let registry = registry_in(server_dir.path());
        let project_path = repo.path().to_string_lossy().into_owned();
        registry.publish_workspace(snapshot_with_project(&project_path));

        let (worktree_id, path) = registry
            .create_worktree_headless(
                "project-1",
                &NewWorktreeSpec {
                    parent_worktree_id: "worktree-main".to_string(),
                    branch: "from-mobile".to_string(),
                    title: Some("From mobile".to_string()),
                },
            )
            .expect("headless worktree creation");

        assert!(
            std::path::Path::new(&path).join(".git").exists(),
            "git checkout should exist at {path}"
        );
        assert!(path.ends_with(&worktree_id), "path is named by worktree id");

        // The mirrored snapshot gained the worktree and persisted it for the
        // next server process.
        let reloaded = registry_in(server_dir.path());
        let (snapshot, _rx) = reloaded.subscribe_workspace().expect("subscribe");
        let payload = match snapshot.first() {
            Some(EventFrame::Snapshot { payload, .. }) => payload.clone(),
            other => panic!("expected snapshot frame, got {other:?}"),
        };
        let worktrees = payload["worktrees"].as_array().expect("worktrees array");
        let adopted = worktrees
            .iter()
            .find(|worktree| worktree["id"] == worktree_id.as_str())
            .expect("new worktree mirrored");
        assert_eq!(adopted["branch"], "from-mobile");
        assert_eq!(adopted["title"], "From mobile");
        assert_eq!(adopted["parentId"], "worktree-main");
    }

    #[test]
    fn headless_new_worktree_requires_a_known_parent() {
        let server_dir = tempdir().expect("server dir");
        let registry = registry_in(server_dir.path());
        registry.publish_workspace(snapshot_with_project("/tmp/sandbox"));
        let error = registry
            .create_worktree_headless(
                "project-1",
                &NewWorktreeSpec {
                    parent_worktree_id: "missing".to_string(),
                    branch: "branch".to_string(),
                    title: None,
                },
            )
            .expect_err("unknown parent must fail");
        assert!(error.contains("parent worktree"), "got: {error}");
    }

    fn agent_payload(status: AgentStatus) -> AgentReportPayload {
        AgentReportPayload {
            agent: "opencode".to_string(),
            worktree_id: "worktree-1".to_string(),
            tab_id: "tab-1".to_string(),
            status,
            attention_kind: None,
            command: None,
            question: None,
            options: vec![],
            request_id: None,
        }
    }

    #[test]
    fn agent_messages_replay_to_late_subscribers_and_drop_with_the_tab() {
        let registry = Registry::default();
        let message: AgentMessage = serde_json::from_value(serde_json::json!({
            "agent": "claude-code",
            "worktreeId": "worktree-1",
            "tabId": "tab-1",
            "id": "msg-1",
            "role": "assistant",
            "text": "All done.",
            "subAgentsActive": 0,
            "ts": 1,
        }))
        .expect("valid message");
        registry.report_agent_message(message);

        let (snapshot, _rx) = registry.subscribe_agents().expect("subscribe");
        assert!(
            snapshot.iter().any(|event| matches!(
                event,
                EventFrame::AgentMessage { message } if message.text.as_deref() == Some("All done.")
            )),
            "late subscribers should see the buffered chat message"
        );

        registry.clear_agents_for_tab("tab-1");
        let (after, _rx) = registry.subscribe_agents().expect("subscribe");
        assert!(
            !after
                .iter()
                .any(|event| matches!(event, EventFrame::AgentMessage { .. })),
            "closing the tab drops its chat history"
        );
    }

    fn agent_decision(request_id: &str) -> AgentDecision {
        AgentDecision {
            agent: "opencode".to_string(),
            worktree_id: "worktree-1".to_string(),
            tab_id: "tab-1".to_string(),
            request_id: request_id.to_string(),
            approved: true,
        }
    }

    #[test]
    fn cleared_report_stores_an_idle_status() {
        let registry = Registry::default();
        registry
            .report_agent(agent_payload(AgentStatus::Running))
            .expect("running report should store");
        let (before, _rx) = registry.subscribe_agents().expect("subscribe");
        assert_eq!(before.len(), 1, "running status should be in the snapshot");

        registry
            .report_agent(agent_payload(AgentStatus::Cleared))
            .expect("cleared report should store");
        let (after, _rx) = registry.subscribe_agents().expect("subscribe");
        assert!(
            matches!(
                after.as_slice(),
                [EventFrame::Agent {
                    status: AgentStatus::Cleared,
                    ..
                }]
            ),
            "cleared keeps the session listed as idle so late subscribers see it exists"
        );
    }

    #[test]
    fn agent_status_subscription_replays_and_updates_full_statuses() {
        let registry = Registry::default();
        registry
            .report_agent(agent_payload(AgentStatus::Running))
            .expect("running report should store");

        let (snapshot, rx) = registry
            .subscribe_agent_status()
            .expect("agent status subscription should start");
        assert!(matches!(
            snapshot.as_slice(),
            [EventFrame::Snapshot { payload, .. }] if payload.as_array().is_some_and(|items| items.len() == 1)
        ));

        registry
            .report_agent(agent_payload(AgentStatus::Cleared))
            .expect("cleared report should publish");
        let update = rx.recv().expect("status update should reach subscriber");
        assert!(matches!(
            update,
            EventFrame::Delta { payload, .. }
                if payload.as_array().is_some_and(|items| {
                    items.len() == 1 && items[0]["status"] == "cleared"
                })
        ));
    }

    #[test]
    fn report_agent_decision_fans_out_to_subscribers() {
        let registry = Registry::default();
        let (_snapshot, rx) = registry.subscribe_agents().expect("subscribe");
        registry.report_agent_decision(agent_decision("req-1"));
        match rx.recv().expect("decision event") {
            EventFrame::AgentDecision { decision } => {
                assert_eq!(decision.request_id, "req-1");
                assert!(decision.approved);
            }
            other => panic!("expected decision event, got {other:?}"),
        }
    }

    #[test]
    fn report_agent_decision_replays_to_late_subscribers() {
        let registry = Registry::default();
        registry.report_agent_decision(agent_decision("req-1"));

        let (snapshot, _rx) = registry.subscribe_agents().expect("subscribe");

        assert!(snapshot.iter().any(|event| matches!(
            event,
            EventFrame::AgentDecision { decision } if decision.request_id == "req-1"
        )));
    }

    #[test]
    fn subscribe_agents_prunes_expired_agent_decisions() {
        let registry = Registry::default();
        registry
            .recent_agent_decisions
            .lock()
            .expect("recent decisions")
            .push(RecentAgentDecision {
                decision: agent_decision("old-req"),
                recorded_at: Instant::now()
                    .checked_sub(AGENT_DECISION_REPLAY_WINDOW * 2)
                    .expect("test clock underflow"),
            });

        let (snapshot, _rx) = registry.subscribe_agents().expect("subscribe");

        assert!(snapshot.iter().all(|event| !matches!(
            event,
            EventFrame::AgentDecision { decision } if decision.request_id == "old-req"
        )));
    }

    fn agent_answer(request_id: &str) -> AgentAnswer {
        AgentAnswer {
            agent: "opencode".to_string(),
            worktree_id: "worktree-1".to_string(),
            tab_id: "tab-1".to_string(),
            request_id: request_id.to_string(),
            answer: Some("option B".to_string()),
            dismissed: false,
        }
    }

    #[test]
    fn report_agent_answer_fans_out_to_subscribers() {
        let registry = Registry::default();
        let (_snapshot, rx) = registry.subscribe_agents().expect("subscribe");
        registry.report_agent_answer(agent_answer("req-1"));
        match rx.recv().expect("answer event") {
            EventFrame::AgentAnswer { answer } => {
                assert_eq!(answer.request_id, "req-1");
                assert_eq!(answer.answer.as_deref(), Some("option B"));
            }
            other => panic!("expected answer event, got {other:?}"),
        }
    }

    #[test]
    fn report_agent_input_fans_out_to_subscribers() {
        let registry = Registry::default();
        let (_snapshot, rx) = registry.subscribe_agents().expect("subscribe");
        registry.report_agent_input(AgentInput {
            agent: "opencode".to_string(),
            worktree_id: "wt-1".to_string(),
            tab_id: "tab-1".to_string(),
            text: "focus on the tests".to_string(),
            request_id: None,
        });
        match rx.recv().expect("input event") {
            EventFrame::AgentInput { input } => {
                assert_eq!(input.agent, "opencode");
                assert_eq!(input.text, "focus on the tests");
            }
            other => panic!("expected input event, got {other:?}"),
        }
    }

    #[test]
    fn report_agent_input_fans_out_without_a_controller() {
        let (registry, session_id, _dir) = spawn_session();
        let (_snapshot, agent_rx) = registry.subscribe_agents().expect("subscribe");

        registry.report_agent_input(AgentInput {
            agent: "opencode".to_string(),
            worktree_id: "worktree-1".to_string(),
            tab_id: session_id.clone(),
            text: "printf __HEADLESS_REPLY__".to_string(),
            request_id: None,
        });

        match agent_rx.recv().expect("input event") {
            EventFrame::AgentInput { input } => {
                assert_eq!(input.tab_id, session_id);
                assert_eq!(input.text, "printf __HEADLESS_REPLY__");
            }
            other => panic!("expected input event, got {other:?}"),
        }
    }

    #[test]
    fn report_agent_interrupt_fans_out_to_subscribers() {
        let registry = Registry::default();
        let (_snapshot, rx) = registry.subscribe_agents().expect("subscribe");
        registry.report_agent_interrupt(AgentInterrupt {
            agent: "opencode".to_string(),
            worktree_id: "wt-1".to_string(),
            tab_id: "tab-1".to_string(),
            request_id: None,
        });
        match rx.recv().expect("interrupt event") {
            EventFrame::AgentInterrupt { interrupt } => {
                assert_eq!(interrupt.agent, "opencode");
                assert_eq!(interrupt.tab_id, "tab-1");
            }
            other => panic!("expected interrupt event, got {other:?}"),
        }
    }

    #[test]
    fn report_agent_interrupt_is_not_replayed_to_late_subscribers() {
        let registry = Registry::default();
        registry.report_agent_interrupt(AgentInterrupt {
            agent: "opencode".to_string(),
            worktree_id: "wt-1".to_string(),
            tab_id: "tab-1".to_string(),
            request_id: None,
        });

        let (snapshot, _rx) = registry.subscribe_agents().expect("subscribe");

        assert!(!snapshot
            .iter()
            .any(|event| matches!(event, EventFrame::AgentInterrupt { .. })));
    }

    #[test]
    fn report_agent_input_is_not_replayed_to_late_subscribers() {
        let registry = Registry::default();
        registry.report_agent_input(AgentInput {
            agent: "opencode".to_string(),
            worktree_id: "wt-1".to_string(),
            tab_id: "tab-1".to_string(),
            text: "too late".to_string(),
            request_id: None,
        });

        let (snapshot, _rx) = registry.subscribe_agents().expect("subscribe");

        assert!(!snapshot
            .iter()
            .any(|event| matches!(event, EventFrame::AgentInput { .. })));
    }

    #[test]
    fn report_agent_answer_replays_to_late_subscribers() {
        let registry = Registry::default();
        registry.report_agent_answer(agent_answer("req-1"));

        let (snapshot, _rx) = registry.subscribe_agents().expect("subscribe");

        assert!(snapshot.iter().any(|event| matches!(
            event,
            EventFrame::AgentAnswer { answer } if answer.request_id == "req-1"
        )));
    }

    #[test]
    fn subscribe_agents_prunes_expired_agent_answers() {
        let registry = Registry::default();
        registry
            .recent_agent_answers
            .lock()
            .expect("recent answers")
            .push(RecentAgentAnswer {
                answer: agent_answer("old-req"),
                recorded_at: Instant::now()
                    .checked_sub(AGENT_DECISION_REPLAY_WINDOW * 2)
                    .expect("test clock underflow"),
            });

        let (snapshot, _rx) = registry.subscribe_agents().expect("subscribe");

        assert!(snapshot.iter().all(|event| !matches!(
            event,
            EventFrame::AgentAnswer { answer } if answer.request_id == "old-req"
        )));
    }

    #[test]
    fn mark_seen_downgrades_only_done_statuses_for_the_tab() {
        let registry = Registry::default();
        let payload = |tab: &str, agent: &str, status| AgentReportPayload {
            agent: agent.to_string(),
            worktree_id: "worktree-1".to_string(),
            tab_id: tab.to_string(),
            status,
            attention_kind: None,
            command: None,
            question: None,
            options: vec![],
            request_id: None,
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
        remaining.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then(format!("{:?}", a.1).cmp(&format!("{:?}", b.1)))
        });
        assert_eq!(
            remaining,
            vec![
                ("tab-1".to_string(), AgentStatus::Cleared),
                ("tab-1".to_string(), AgentStatus::Running),
                ("tab-2".to_string(), AgentStatus::Done),
            ],
            "only tab-1's done downgrades to idle; its running and other tabs survive"
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

    /// Regression test: a size-less attach (a plugin watcher tailing output)
    /// must not resize the PTY out from under the interactive client — the
    /// old behavior shrank a fitted terminal back to a hardcoded 80x24.
    #[test]
    fn attach_without_size_leaves_the_pty_grid_alone() {
        let (registry, id, _dir) = spawn_session();
        registry
            .resize(&id, 120, 40)
            .expect("interactive client resize");

        let (_scrollback, rx) = registry.attach(&id, None).expect("observer attach");
        registry.write(&id, "stty size\r").expect("write");

        let mut output = String::new();
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Ok(EventFrame::Output { data, .. }) =
                rx.recv_timeout(std::time::Duration::from_millis(200))
            {
                output.push_str(&String::from_utf8_lossy(&data));
                if output.contains("40 120") {
                    return;
                }
            }
        }
        panic!("expected stty to report 40 120 (rows cols); output was: {output:?}");
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
                command: None,
                question: None,
                options: vec![],
                request_id: None,
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
