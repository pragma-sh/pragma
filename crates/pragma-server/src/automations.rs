use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pragma_constants::{
    AutomationInfo, AutomationRootRegistration, AutomationScope, AutomationStatus,
    AutomationTriggerKind, AutomationTrust, FileContents, ProtocolEventKind,
};
use pragma_protocol::EventFrame;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

const SCAN_INTERVAL: Duration = Duration::from_secs(5);
const CRON_INTERVAL: Duration = Duration::from_secs(20);
const AUTOMATIONS_DIR: &str = ".pragma/automations";
const TRUST_FILE: &str = "automations-state.json";
const SIDECAR_NAME: &str = "pragma-automations";

/// Automation source files larger than this are reported as `truncated` and not
/// returned across the wire — same cap as the worktree `readFile` path.
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum AutomationError {
    #[error("automation not found: {0}")]
    NotFound(String),
    #[error("invalid automation request: {0}")]
    InvalidRequest(String),
    #[error("automation operation failed: {0}")]
    Operation(String),
    #[error("automation sidecar disconnected: {0}")]
    SidecarDisconnected(String),
    #[error("lock poisoned")]
    LockPoisoned,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    #[serde(default)]
    trust: HashMap<String, TrustRecord>,
    #[serde(default)]
    projects: Vec<AutomationRootRegistration>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrustRecord {
    verdict: TrustVerdict,
    content_hash: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum TrustVerdict {
    Approved,
    Rejected,
    Pending,
}

#[derive(Clone, Debug)]
struct DiscoveredAutomation {
    info: AutomationInfo,
    content_hash: String,
    schedule: Option<String>,
    root: String,
}

#[derive(Clone, Debug)]
struct AutomationRuntime {
    info: AutomationInfo,
    content_hash: String,
    schedule: Option<String>,
    root: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum AutomationRequest {
    RegisterRoots {
        #[serde(default)]
        projects: Vec<AutomationRootRegistration>,
    },
    List,
    Approve {
        id: String,
    },
    Reject {
        id: String,
    },
    RunNow {
        id: String,
    },
    ReadSource {
        id: String,
    },
    WriteSource {
        id: String,
        contents: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum SidecarEvent {
    Ready,
    Loaded {
        id: String,
        name: String,
        description: String,
        trigger_kind: AutomationTriggerKind,
        schedule: Option<String>,
    },
    Status {
        id: String,
        status: AutomationStatus,
    },
    Error {
        id: Option<String>,
        error: String,
    },
    Log {
        id: String,
        level: String,
        message: String,
        #[serde(default)]
        data: Value,
    },
    Unloaded {
        id: String,
    },
}

pub struct AutomationsRegistry {
    server_dir: PathBuf,
    state_path: PathBuf,
    trust: Mutex<HashMap<String, TrustRecord>>,
    projects: Mutex<Vec<AutomationRootRegistration>>,
    automations: Mutex<HashMap<String, AutomationRuntime>>,
    loaded_hashes: Mutex<HashMap<String, String>>,
    cron_minutes: Mutex<HashMap<String, u64>>,
    pending_subscribers: Mutex<Vec<Sender<EventFrame>>>,
    changed_subscribers: Mutex<Vec<Sender<EventFrame>>>,
    sidecar: AutomationSidecar,
}

impl AutomationsRegistry {
    #[must_use]
    pub fn new(server_dir: PathBuf) -> Arc<Self> {
        let state_path = server_dir.join(TRUST_FILE);
        let persisted = read_state(&state_path);
        let (sidecar_tx, sidecar_rx) = mpsc::channel();
        let registry = Arc::new(Self {
            server_dir,
            state_path,
            trust: Mutex::new(persisted.trust),
            projects: Mutex::new(persisted.projects),
            automations: Mutex::new(HashMap::new()),
            loaded_hashes: Mutex::new(HashMap::new()),
            cron_minutes: Mutex::new(HashMap::new()),
            pending_subscribers: Mutex::new(Vec::new()),
            changed_subscribers: Mutex::new(Vec::new()),
            sidecar: AutomationSidecar::new(sidecar_tx),
        });
        Self::start_threads(&registry, sidecar_rx);
        registry
    }

    pub fn handle_rpc(&self, payload: Value) -> Result<Value, AutomationError> {
        let request: AutomationRequest = serde_json::from_value(payload)
            .map_err(|err| AutomationError::InvalidRequest(err.to_string()))?;
        match request {
            AutomationRequest::RegisterRoots { projects } => {
                self.register_roots(projects)?;
                self.scan_once()?;
                Ok(json!({ "ok": true }))
            }
            AutomationRequest::List => Ok(serde_json::to_value(self.list()?)
                .map_err(|err| AutomationError::Operation(err.to_string()))?),
            AutomationRequest::Approve { id } => {
                self.set_verdict(&id, TrustVerdict::Approved)?;
                self.scan_once()?;
                Ok(json!({ "ok": true }))
            }
            AutomationRequest::Reject { id } => {
                self.set_verdict(&id, TrustVerdict::Rejected)?;
                self.scan_once()?;
                Ok(json!({ "ok": true }))
            }
            AutomationRequest::RunNow { id } => {
                self.send_sidecar(&json!({ "type": "runNow", "id": id }))?;
                Ok(json!({ "ok": true }))
            }
            AutomationRequest::ReadSource { id } => serde_json::to_value(self.read_source(&id)?)
                .map_err(|err| AutomationError::Operation(err.to_string())),
            AutomationRequest::WriteSource { id, contents } => {
                self.write_source(&id, &contents)?;
                self.scan_once()?;
                Ok(json!({ "ok": true }))
            }
        }
    }

    pub fn subscribe_pending(
        &self,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), AutomationError> {
        let (tx, rx) = mpsc::channel();
        self.pending_subscribers
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?
            .push(tx);
        let pending: Vec<AutomationInfo> = self
            .list()?
            .into_iter()
            .filter(|automation| matches!(automation.trust, AutomationTrust::Pending))
            .collect();
        Ok((
            vec![EventFrame::Snapshot {
                subscription: ProtocolEventKind::AutomationPending,
                payload: serde_json::to_value(pending)
                    .map_err(|err| AutomationError::Operation(err.to_string()))?,
            }],
            rx,
        ))
    }

    pub fn subscribe_changed(
        &self,
    ) -> Result<(Vec<EventFrame>, Receiver<EventFrame>), AutomationError> {
        let (tx, rx) = mpsc::channel();
        self.changed_subscribers
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?
            .push(tx);
        Ok((
            vec![EventFrame::Snapshot {
                subscription: ProtocolEventKind::AutomationsChanged,
                payload: serde_json::to_value(self.list()?)
                    .map_err(|err| AutomationError::Operation(err.to_string()))?,
            }],
            rx,
        ))
    }

    fn start_threads(registry: &Arc<Self>, sidecar_rx: Receiver<SidecarEvent>) {
        let scanner = Arc::clone(registry);
        thread::spawn(move || loop {
            if let Err(err) = scanner.scan_once() {
                eprintln!("automation scan failed: {err}");
            }
            thread::sleep(SCAN_INTERVAL);
        });

        let cron = Arc::clone(registry);
        thread::spawn(move || loop {
            if let Err(err) = cron.tick_cron() {
                eprintln!("automation cron failed: {err}");
            }
            thread::sleep(CRON_INTERVAL);
        });

        let events = Arc::clone(registry);
        thread::spawn(move || {
            for event in sidecar_rx {
                events.handle_sidecar_event(event);
            }
        });
    }

    fn register_roots(
        &self,
        projects: Vec<AutomationRootRegistration>,
    ) -> Result<(), AutomationError> {
        *self
            .projects
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)? = projects;
        self.persist_state()
    }

    fn set_verdict(&self, id: &str, verdict: TrustVerdict) -> Result<(), AutomationError> {
        let runtime = self
            .automations
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?
            .get(id)
            .cloned()
            .ok_or_else(|| AutomationError::NotFound(id.to_string()))?;
        self.trust
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?
            .insert(
                id.to_string(),
                TrustRecord {
                    verdict,
                    content_hash: runtime.content_hash,
                },
            );
        self.persist_state()
    }

    fn list(&self) -> Result<Vec<AutomationInfo>, AutomationError> {
        let mut automations: Vec<AutomationInfo> = self
            .automations
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?
            .values()
            .map(|runtime| runtime.info.clone())
            .collect();
        automations.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(automations)
    }

    fn send_sidecar(&self, command: &Value) -> Result<(), AutomationError> {
        match self.sidecar.send(command) {
            Ok(()) => Ok(()),
            Err(AutomationError::SidecarDisconnected(error)) => {
                eprintln!("automation sidecar disconnected; restarting: {error}");
                self.reload_sidecar()?;
                self.sidecar.send(command)
            }
            Err(error) => Err(error),
        }
    }

    fn reload_sidecar(&self) -> Result<(), AutomationError> {
        self.sidecar.reset()?;
        let automations: Vec<AutomationRuntime> = self
            .automations
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?
            .values()
            .filter(|runtime| {
                matches!(
                    runtime.info.trust,
                    AutomationTrust::Trusted | AutomationTrust::Approved
                )
            })
            .cloned()
            .collect();
        for automation in automations {
            self.sidecar
                .send(&load_command(&automation.info, &automation.root))?;
        }
        Ok(())
    }

    /// Reads the `.ts` source file backing an automation straight from disk, on
    /// whichever host owns the server socket (local for local projects, the
    /// remote box for SSH-bridged ones). Shared by global and local automations.
    fn read_source(&self, id: &str) -> Result<FileContents, AutomationError> {
        let path_string = {
            let automations = self
                .automations
                .lock()
                .map_err(|_| AutomationError::LockPoisoned)?;
            let runtime = automations
                .get(id)
                .ok_or_else(|| AutomationError::NotFound(id.to_string()))?;
            runtime.info.path.clone()
        };
        let path = Path::new(&path_string);
        let metadata = fs::metadata(path)
            .map_err(|err| AutomationError::Operation(format!("stat {}: {err}", path.display())))?;
        let byte_size = metadata.len();
        if byte_size > MAX_SOURCE_BYTES {
            return Ok(FileContents {
                path: path_string,
                text: String::new(),
                binary: false,
                truncated: true,
                byte_size,
            });
        }
        let bytes = fs::read(path)
            .map_err(|err| AutomationError::Operation(format!("read {}: {err}", path.display())))?;
        match String::from_utf8(bytes) {
            Ok(text) => Ok(FileContents {
                path: path_string,
                text,
                binary: false,
                truncated: false,
                byte_size,
            }),
            Err(_) => Ok(FileContents {
                path: path_string,
                text: String::new(),
                binary: true,
                truncated: false,
                byte_size,
            }),
        }
    }

    /// Overwrites the `.ts` source file backing an automation with UTF-8 text.
    fn write_source(&self, id: &str, contents: &str) -> Result<(), AutomationError> {
        let path_string = {
            let automations = self
                .automations
                .lock()
                .map_err(|_| AutomationError::LockPoisoned)?;
            let runtime = automations
                .get(id)
                .ok_or_else(|| AutomationError::NotFound(id.to_string()))?;
            runtime.info.path.clone()
        };
        let path = Path::new(&path_string);
        fs::write(path, contents)
            .map_err(|err| AutomationError::Operation(format!("write {}: {err}", path.display())))
    }

    fn scan_once(&self) -> Result<(), AutomationError> {
        let discovered = self.discover()?;
        let mut pending_to_emit = Vec::new();
        let mut load_commands = Vec::new();
        let mut unload_ids = Vec::new();
        let mut next = HashMap::new();
        let current_ids: HashSet<String> =
            discovered.iter().map(|item| item.info.id.clone()).collect();
        let previous = self
            .automations
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?
            .clone();

        {
            let mut loaded_hashes = self
                .loaded_hashes
                .lock()
                .map_err(|_| AutomationError::LockPoisoned)?;
            for item in discovered {
                let id = item.info.id.clone();
                let newly_pending = matches!(item.info.trust, AutomationTrust::Pending)
                    && previous.get(&id).is_none_or(|old| {
                        !matches!(old.info.trust, AutomationTrust::Pending)
                            || old.content_hash != item.content_hash
                    });
                if newly_pending {
                    pending_to_emit.push(item.info.clone());
                }
                if matches!(
                    item.info.trust,
                    AutomationTrust::Trusted | AutomationTrust::Approved
                ) {
                    let needs_load = loaded_hashes.get(&id) != Some(&item.content_hash);
                    if needs_load {
                        loaded_hashes.insert(id.clone(), item.content_hash.clone());
                        load_commands.push(item.clone());
                    }
                } else if loaded_hashes.remove(&id).is_some() {
                    unload_ids.push(id.clone());
                }
                next.insert(
                    id,
                    AutomationRuntime {
                        info: item.info,
                        content_hash: item.content_hash,
                        schedule: item.schedule,
                        root: item.root,
                    },
                );
            }

            let previous_ids: Vec<String> = loaded_hashes.keys().cloned().collect();
            for id in previous_ids {
                if !current_ids.contains(&id) {
                    loaded_hashes.remove(&id);
                    unload_ids.push(id);
                }
            }
        }

        *self
            .automations
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)? = next;
        for id in unload_ids {
            let _ = self.send_sidecar(&json!({ "type": "unload", "id": id }));
        }
        for item in load_commands {
            self.load_sidecar(&item)?;
        }
        for automation in pending_to_emit {
            self.broadcast_pending(&automation);
        }
        let _ = self.persist_state();
        self.broadcast_changed();
        Ok(())
    }

    fn discover(&self) -> Result<Vec<DiscoveredAutomation>, AutomationError> {
        let mut discovered = Vec::new();
        if let Some(home) = std::env::var_os("HOME") {
            // Global automations are confined to the automations dir itself;
            // without the override the fallback root would be $HOME.
            let dir = PathBuf::from(home).join(".pragma/automations");
            let root = dir.to_string_lossy().into_owned();
            self.discover_dir(
                &dir,
                AutomationScope::Global,
                None,
                None,
                Some(&root),
                &mut discovered,
            )?;
        }
        let projects = self
            .projects
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?
            .clone();
        for project in projects {
            self.discover_dir(
                &Path::new(&project.project_path).join(AUTOMATIONS_DIR),
                AutomationScope::Local,
                Some(project.project_id.as_str()),
                None,
                None,
                &mut discovered,
            )?;
            for worktree in project.worktrees {
                if Path::new(&worktree.path) == Path::new(&project.project_path) {
                    continue;
                }
                self.discover_dir(
                    &Path::new(&worktree.path).join(AUTOMATIONS_DIR),
                    AutomationScope::Local,
                    Some(project.project_id.as_str()),
                    Some((worktree.worktree_id.as_str(), worktree.label.as_str())),
                    Some(worktree.path.as_str()),
                    &mut discovered,
                )?;
            }
        }
        Ok(discovered)
    }

    #[allow(clippy::too_many_arguments)]
    fn discover_dir(
        &self,
        dir: &Path,
        scope: AutomationScope,
        project_id: Option<&str>,
        worktree: Option<(&str, &str)>,
        root_override: Option<&str>,
        discovered: &mut Vec<DiscoveredAutomation>,
    ) -> Result<(), AutomationError> {
        if !dir.exists() {
            return Ok(());
        }
        let root = root_override.map_or_else(
            || {
                dir.parent()
                    .and_then(Path::parent)
                    .unwrap_or(dir)
                    .to_string_lossy()
                    .into_owned()
            },
            ToOwned::to_owned,
        );
        for path in automation_files(dir)? {
            let source = fs::read_to_string(&path).map_err(|err| {
                AutomationError::Operation(format!("read {}: {err}", path.display()))
            })?;
            let content_hash = stable_hash(&source);
            let id = format!("automation-{}", stable_hash(&path.to_string_lossy()));
            let metadata = parse_metadata(&source, &path);
            let trust = self.trust_for(&id, &content_hash, scope);
            let status = match trust {
                AutomationTrust::Trusted | AutomationTrust::Approved => AutomationStatus::Loaded,
                AutomationTrust::Pending => AutomationStatus::Pending,
                AutomationTrust::Rejected => AutomationStatus::Rejected,
            };
            let dir_relative_path = path
                .strip_prefix(dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            let relative_path = if matches!(scope, AutomationScope::Local) {
                format!("{AUTOMATIONS_DIR}/{dir_relative_path}")
            } else {
                dir_relative_path
            };
            let (worktree_id, worktree_label) = worktree.map_or((None, None), |(id, label)| {
                (Some(id.to_string()), Some(label.to_string()))
            });
            let next_run_at = metadata
                .schedule
                .as_deref()
                .and_then(|schedule| next_matching_minute(schedule, now_minutes()))
                .map(|minute| (minute * 60).to_string());
            discovered.push(DiscoveredAutomation {
                info: AutomationInfo {
                    id,
                    name: metadata.name,
                    description: metadata.description,
                    path: path.to_string_lossy().into_owned(),
                    relative_path,
                    source_version: content_hash.clone(),
                    scope,
                    trust,
                    trigger_kind: metadata.trigger_kind,
                    status,
                    project_id: project_id.map(ToOwned::to_owned),
                    worktree_id,
                    worktree_label,
                    last_run_at: None,
                    next_run_at,
                    error: None,
                },
                content_hash,
                schedule: metadata.schedule,
                root: root.clone(),
            });
        }
        Ok(())
    }

    fn trust_for(&self, id: &str, content_hash: &str, scope: AutomationScope) -> AutomationTrust {
        if matches!(scope, AutomationScope::Global) {
            return AutomationTrust::Trusted;
        }
        let Ok(mut trust) = self.trust.lock() else {
            return AutomationTrust::Pending;
        };
        match trust.get(id) {
            Some(record) if matches!(record.verdict, TrustVerdict::Approved) => {
                AutomationTrust::Approved
            }
            Some(record)
                if matches!(record.verdict, TrustVerdict::Rejected)
                    && record.content_hash == content_hash =>
            {
                AutomationTrust::Rejected
            }
            Some(record)
                if matches!(record.verdict, TrustVerdict::Pending)
                    && record.content_hash == content_hash =>
            {
                AutomationTrust::Pending
            }
            _ => {
                trust.insert(
                    id.to_string(),
                    TrustRecord {
                        verdict: TrustVerdict::Pending,
                        content_hash: content_hash.to_string(),
                    },
                );
                AutomationTrust::Pending
            }
        }
    }

    fn load_sidecar(&self, item: &DiscoveredAutomation) -> Result<(), AutomationError> {
        self.send_load_command(&item.info, &item.root)
    }

    fn send_load_command(&self, info: &AutomationInfo, root: &str) -> Result<(), AutomationError> {
        self.send_sidecar(&load_command(info, root))
    }

    fn tick_cron(&self) -> Result<(), AutomationError> {
        let minute = now_minutes();
        let automations: Vec<AutomationRuntime> = self
            .automations
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?
            .values()
            .cloned()
            .collect();
        let mut cron_minutes = self
            .cron_minutes
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?;
        for automation in automations {
            let Some(schedule) = automation.schedule.as_deref() else {
                continue;
            };
            if !matches!(
                automation.info.trust,
                AutomationTrust::Trusted | AutomationTrust::Approved
            ) {
                continue;
            }
            if cron_matches(schedule, minute)
                && cron_minutes.get(&automation.info.id) != Some(&minute)
            {
                cron_minutes.insert(automation.info.id.clone(), minute);
                self.send_sidecar(&json!({ "type": "runNow", "id": automation.info.id }))?;
            }
        }
        Ok(())
    }

    fn handle_sidecar_event(&self, event: SidecarEvent) {
        match event {
            SidecarEvent::Ready => {}
            SidecarEvent::Loaded {
                id,
                name,
                description,
                trigger_kind,
                schedule,
            } => {
                if let Ok(mut automations) = self.automations.lock() {
                    if let Some(runtime) = automations.get_mut(&id) {
                        runtime.info.name = name;
                        runtime.info.description = description;
                        runtime.info.trigger_kind = trigger_kind;
                        runtime.info.status = AutomationStatus::Idle;
                        runtime.info.error = None;
                        runtime.schedule = schedule;
                    }
                }
                self.broadcast_changed();
            }
            SidecarEvent::Status { id, status } => {
                if let Ok(mut automations) = self.automations.lock() {
                    if let Some(runtime) = automations.get_mut(&id) {
                        runtime.info.status = status;
                        if matches!(runtime.info.status, AutomationStatus::Running) {
                            runtime.info.last_run_at = Some(now_seconds().to_string());
                        }
                    }
                }
                self.broadcast_changed();
            }
            SidecarEvent::Error { id, error } => {
                if let Some(id) = id {
                    if let Ok(mut automations) = self.automations.lock() {
                        if let Some(runtime) = automations.get_mut(&id) {
                            runtime.info.status = AutomationStatus::Error;
                            runtime.info.error = Some(error);
                        }
                    }
                    self.broadcast_changed();
                } else {
                    eprintln!("automation sidecar error: {error}");
                }
            }
            SidecarEvent::Log {
                id,
                level,
                message,
                data,
            } => {
                eprintln!("automation {id} {level}: {message} {data}");
            }
            SidecarEvent::Unloaded { id } => {
                if let Ok(mut automations) = self.automations.lock() {
                    if let Some(runtime) = automations.get_mut(&id) {
                        runtime.info.status = AutomationStatus::Pending;
                    }
                }
                self.broadcast_changed();
            }
        }
    }

    fn broadcast_pending(&self, automation: &AutomationInfo) {
        let event = EventFrame::Delta {
            subscription: ProtocolEventKind::AutomationPending,
            payload: json!({ "automation": automation }),
        };
        if let Ok(mut subscribers) = self.pending_subscribers.lock() {
            subscribers.retain(|tx| tx.send(event.clone()).is_ok());
        }
    }

    fn broadcast_changed(&self) {
        let Ok(automations) = self.list() else {
            return;
        };
        let event = EventFrame::Delta {
            subscription: ProtocolEventKind::AutomationsChanged,
            payload: serde_json::to_value(automations).unwrap_or_else(|_| Value::Array(Vec::new())),
        };
        if let Ok(mut subscribers) = self.changed_subscribers.lock() {
            subscribers.retain(|tx| tx.send(event.clone()).is_ok());
        }
    }

    fn persist_state(&self) -> Result<(), AutomationError> {
        let state = PersistedState {
            trust: self
                .trust
                .lock()
                .map_err(|_| AutomationError::LockPoisoned)?
                .clone(),
            projects: self
                .projects
                .lock()
                .map_err(|_| AutomationError::LockPoisoned)?
                .clone(),
        };
        fs::create_dir_all(&self.server_dir)
            .map_err(|err| AutomationError::Operation(format!("create state dir: {err}")))?;
        let json = serde_json::to_string_pretty(&state)
            .map_err(|err| AutomationError::Operation(err.to_string()))?;
        fs::write(&self.state_path, json)
            .map_err(|err| AutomationError::Operation(format!("write state: {err}")))
    }
}

struct AutomationSidecar {
    tx: Sender<SidecarEvent>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

impl AutomationSidecar {
    fn new(tx: Sender<SidecarEvent>) -> Self {
        Self {
            tx,
            child: Mutex::new(None),
            stdin: Mutex::new(None),
        }
    }

    fn send(&self, command: &Value) -> Result<(), AutomationError> {
        self.ensure_running()?;
        let result = {
            let mut stdin = self
                .stdin
                .lock()
                .map_err(|_| AutomationError::LockPoisoned)?;
            let Some(stdin) = stdin.as_mut() else {
                return Err(AutomationError::SidecarDisconnected(
                    "automation sidecar stdin unavailable".to_string(),
                ));
            };
            writeln!(stdin, "{command}").and_then(|()| stdin.flush())
        };
        match result {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::BrokenPipe => {
                self.reset()?;
                Err(AutomationError::SidecarDisconnected(err.to_string()))
            }
            Err(err) => Err(AutomationError::Operation(format!(
                "write sidecar command: {err}"
            ))),
        }
    }

    fn reset(&self) -> Result<(), AutomationError> {
        let child = {
            let mut child = self
                .child
                .lock()
                .map_err(|_| AutomationError::LockPoisoned)?;
            let child = child.take();
            self.stdin
                .lock()
                .map_err(|_| AutomationError::LockPoisoned)?
                .take();
            child
        };
        if let Some(mut child) = child {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    fn clear_exited_child(&self) -> Result<bool, AutomationError> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?;
        let Some(process) = child.as_mut() else {
            return Ok(false);
        };
        let Some(status) = process
            .try_wait()
            .map_err(|err| AutomationError::Operation(format!("poll automation sidecar: {err}")))?
        else {
            return Ok(false);
        };
        eprintln!("automation sidecar exited: {status}");
        child.take();
        self.stdin
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?
            .take();
        Ok(true)
    }

    fn ensure_running(&self) -> Result<(), AutomationError> {
        let has_child = self
            .child
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)?
            .is_some();
        if has_child && !self.clear_exited_child()? {
            return Ok(());
        }
        let mut command = sidecar_command();
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|err| {
            AutomationError::Operation(format!("spawn automation sidecar: {err}"))
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            AutomationError::Operation("automation sidecar stdin missing".to_string())
        })?;
        if let Some(stdout) = child.stdout.take() {
            let tx = self.tx.clone();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    match serde_json::from_str::<SidecarEvent>(&line) {
                        Ok(event) => {
                            let _ = tx.send(event);
                        }
                        Err(err) => {
                            eprintln!("automation sidecar emitted invalid JSON: {err}: {line}");
                        }
                    }
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    eprintln!("automation sidecar: {line}");
                }
            });
        }
        *self
            .stdin
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)? = Some(stdin);
        *self
            .child
            .lock()
            .map_err(|_| AutomationError::LockPoisoned)? = Some(child);
        Ok(())
    }
}

fn load_command(info: &AutomationInfo, root: &str) -> Value {
    json!({
        "type": "load",
        "id": info.id,
        "path": info.path,
        "sourceVersion": info.source_version,
        "root": root,
        "scope": info.scope,
        "projectId": info.project_id,
        "worktreeId": info.worktree_id,
    })
}

fn sidecar_command() -> Command {
    if cfg!(debug_assertions) {
        let mut command = Command::new("bun");
        command
            .arg("packages/automations/src/cli.ts")
            .current_dir(workspace_root())
            .env("PRAGMA_AUTOMATIONS_CACHE", automation_cache_dir());
        command
    } else {
        let mut command = Command::new(sidecar_executable(SIDECAR_NAME));
        command.env("PRAGMA_AUTOMATIONS_CACHE", automation_cache_dir());
        command
    }
}

fn sidecar_executable(name: &str) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|parent| parent.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

fn automation_cache_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map_or_else(std::env::temp_dir, PathBuf::from)
        .join(".pragma/automation-cache")
}

fn read_state(path: &Path) -> PersistedState {
    File::open(path)
        .ok()
        .and_then(|file| serde_json::from_reader(file).ok())
        .unwrap_or(PersistedState {
            trust: HashMap::new(),
            projects: Vec::new(),
        })
}

fn automation_files(dir: &Path) -> Result<Vec<PathBuf>, AutomationError> {
    let mut files = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(files),
        Err(err) => {
            return Err(AutomationError::Operation(format!(
                "read {}: {err}",
                dir.display()
            )))
        }
    };
    for entry in entries {
        let entry = entry.map_err(|err| AutomationError::Operation(err.to_string()))?;
        let path = entry.path();
        if path.is_dir() {
            files.extend(automation_files(&path)?);
        } else if matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("ts" | "js")
        ) {
            files.push(path);
        }
    }
    Ok(files)
}

#[derive(Clone, Debug)]
struct Metadata {
    name: String,
    description: String,
    trigger_kind: AutomationTriggerKind,
    schedule: Option<String>,
}

fn parse_metadata(source: &str, path: &Path) -> Metadata {
    let fallback = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Automation")
        .replace(['-', '_'], " ");
    let trigger_kind = if source.contains("type: \"cron\"") || source.contains("type: 'cron'") {
        AutomationTriggerKind::Cron
    } else if source.contains("type: \"event\"") || source.contains("type: 'event'") {
        AutomationTriggerKind::Event
    } else {
        AutomationTriggerKind::Unknown
    };
    Metadata {
        name: string_property(source, "name").unwrap_or(fallback),
        description: string_property(source, "description").unwrap_or_default(),
        trigger_kind,
        schedule: string_property(source, "schedule"),
    }
}

fn string_property(source: &str, key: &str) -> Option<String> {
    let key_pos = source.find(key)?;
    let after_key = &source[key_pos + key.len()..];
    let colon = after_key.find(':')?;
    let after_colon = after_key[colon + 1..].trim_start();
    let quote = after_colon.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let mut escaped = false;
    let mut value = String::new();
    for ch in after_colon[1..].chars() {
        if escaped {
            value.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == quote {
            return Some(value);
        } else {
            value.push(ch);
        }
    }
    None
}

fn stable_hash(value: &impl Hash) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn now_minutes() -> u64 {
    now_seconds() / 60
}

fn cron_matches(schedule: &str, minute: u64) -> bool {
    let parts: Vec<&str> = schedule.split_whitespace().collect();
    if parts.len() != 5 {
        return false;
    }
    let minute_of_hour = minute % 60;
    let hour = (minute / 60) % 24;
    let day = ((minute / 60 / 24) % 31) + 1;
    let month = ((minute / 60 / 24 / 31) % 12) + 1;
    let weekday = (minute / 60 / 24 + 4) % 7;
    field_matches(parts[0], minute_of_hour, 0, 59)
        && field_matches(parts[1], hour, 0, 23)
        && field_matches(parts[2], day, 1, 31)
        && field_matches(parts[3], month, 1, 12)
        && field_matches(parts[4], weekday, 0, 6)
}

fn next_matching_minute(schedule: &str, start: u64) -> Option<u64> {
    (start + 1..=start + 60 * 24 * 31).find(|minute| cron_matches(schedule, *minute))
}

fn field_matches(field: &str, value: u64, min: u64, max: u64) -> bool {
    field
        .split(',')
        .any(|part| part_matches(part, value, min, max))
}

fn part_matches(part: &str, value: u64, min: u64, max: u64) -> bool {
    if part == "*" {
        return true;
    }
    if let Some(step) = part
        .strip_prefix("*/")
        .and_then(|raw| raw.parse::<u64>().ok())
    {
        return step != 0 && (value - min).is_multiple_of(step);
    }
    if let Some((start, end)) = part.split_once('-') {
        let Ok(start) = start.parse::<u64>() else {
            return false;
        };
        let Ok(end) = end.parse::<u64>() else {
            return false;
        };
        return value >= start && value <= end && start >= min && end <= max;
    }
    part.parse::<u64>()
        .is_ok_and(|parsed| parsed == value && parsed >= min && parsed <= max)
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::{cron_matches, parse_metadata, SidecarEvent};

    #[test]
    fn parses_camel_case_sidecar_loaded_event() {
        let event: SidecarEvent = serde_json::from_str(
            r#"{"type":"loaded","id":"automation-1","name":"Watch","description":"d","triggerKind":"event","schedule":null}"#,
        )
        .expect("loaded event must parse");
        assert!(matches!(event, SidecarEvent::Loaded { .. }));
    }

    #[test]
    fn parses_static_metadata() {
        let metadata = parse_metadata(
            r#"export default defineAutomation({ name: "Nightly", description: "Runs", trigger: { type: "cron", schedule: "0 3 * * *" }, run() {} })"#,
            std::path::Path::new("nightly.ts"),
        );
        assert_eq!(metadata.name, "Nightly");
        assert_eq!(metadata.description, "Runs");
        assert_eq!(metadata.schedule.as_deref(), Some("0 3 * * *"));
    }

    #[test]
    fn matches_basic_cron_fields() {
        assert!(cron_matches("* * * * *", 123));
        assert!(cron_matches("*/5 * * * *", 125));
        assert!(!cron_matches("*/5 * * * *", 126));
    }
}
