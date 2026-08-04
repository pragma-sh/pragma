//! Background delivery of agent alerts to paired phones.
//!
//! The gateway is the process a phone talks to, so it is also the process that
//! pushes to it: it subscribes to the host's agent status stream, decides which
//! reports are worth waking a phone for, and sends them through Expo. That keeps
//! push working while the desktop window is closed, as long as the host is up.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use pragma_constants::ProtocolEventKind;
use pragma_protocol::{
    read_frame, AgentAttentionKind, AgentStatus, EventFrame, Frame, ServerFrame, WorkspaceSnapshot,
};
use serde_json::{json, Value};

use crate::client::GatewayClient;
use crate::devices::DeviceRegistry;

use super::expo::{self, PushMessage};
use super::presence::DesktopPresence;
use super::text::{alert_body, alert_title};
use super::workspace::WorkspaceMirror;

/// Backoff between reconnects to the host's event streams.
const RECONNECT_DELAY: Duration = Duration::from_secs(2);
/// How long a resolved agent catalog is reused before a name miss refetches it.
const CATALOG_TTL: Duration = Duration::from_mins(1);

/// Everything the push threads need from the gateway.
#[derive(Clone)]
pub struct PushWorker {
    client: GatewayClient,
    devices: Arc<Mutex<DeviceRegistry>>,
    presence: DesktopPresence,
    workspace: WorkspaceMirror,
    http: reqwest::blocking::Client,
    latch: Arc<Mutex<HashMap<String, AgentStatus>>>,
    catalog: Arc<Mutex<AgentNames>>,
}

#[derive(Default)]
struct AgentNames {
    names: HashMap<String, String>,
    fetched_at: Option<Instant>,
}

impl PushWorker {
    /// Creates a worker. Returns `None` when no HTTP client can be built, which
    /// leaves the rest of the gateway working without push.
    #[must_use]
    pub fn new(
        client: GatewayClient,
        devices: Arc<Mutex<DeviceRegistry>>,
        presence: DesktopPresence,
    ) -> Option<Self> {
        let http = reqwest::blocking::Client::builder().build().ok()?;
        Some(Self {
            client,
            devices,
            presence,
            workspace: WorkspaceMirror::default(),
            http,
            latch: Arc::new(Mutex::new(HashMap::new())),
            catalog: Arc::new(Mutex::new(AgentNames::default())),
        })
    }

    /// Starts the workspace-mirror and agent-status threads. Both reconnect for
    /// as long as the gateway runs; a host restart is an ordinary reconnect.
    pub fn start(&self) {
        let mirror_worker = self.clone();
        thread::spawn(move || loop {
            if let Err(error) = mirror_worker.mirror_workspace() {
                eprintln!("push: workspace mirror disconnected: {error}");
            }
            thread::sleep(RECONNECT_DELAY);
        });
        let alert_worker = self.clone();
        thread::spawn(move || loop {
            if let Err(error) = alert_worker.watch_agents() {
                eprintln!("push: agent stream disconnected: {error}");
            }
            thread::sleep(RECONNECT_DELAY);
        });
    }

    /// Sends one notification to every registered phone, outside the agent
    /// stream. Used by `POST /v1/push/test`.
    pub fn notify_all(&self, title: &str, body: &str, data: &Value) -> Result<usize, String> {
        let tokens = self.push_tokens();
        if tokens.is_empty() {
            return Ok(0);
        }
        let messages: Vec<PushMessage> = tokens
            .into_iter()
            .map(|token| PushMessage {
                to: token,
                title: title.to_string(),
                body: body.to_string(),
                data: data.clone(),
                sound: "default",
            })
            .collect();
        let sent = messages.len();
        let dead = expo::send(&self.http, &messages)?;
        self.forget(&dead);
        Ok(sent)
    }

    fn mirror_workspace(&self) -> Result<(), String> {
        let mut stream = self
            .client
            .subscribe_stream(ProtocolEventKind::Workspace, None, None)
            .map_err(|error| error.to_string())?;
        loop {
            let Frame::Json(bytes) = read_frame(&mut stream).map_err(|error| error.to_string())?
            else {
                continue;
            };
            let Ok(ServerFrame::Event(
                EventFrame::Snapshot {
                    subscription: ProtocolEventKind::Workspace,
                    payload,
                }
                | EventFrame::Delta {
                    subscription: ProtocolEventKind::Workspace,
                    payload,
                },
            )) = serde_json::from_slice::<ServerFrame>(&bytes)
            else {
                continue;
            };
            if let Ok(snapshot) = serde_json::from_value::<WorkspaceSnapshot>(payload) {
                self.workspace.replace(snapshot);
            }
        }
    }

    fn watch_agents(&self) -> Result<(), String> {
        let mut stream = self
            .client
            .subscribe_agents_stream()
            .map_err(|error| error.to_string())?;
        loop {
            let Frame::Json(bytes) = read_frame(&mut stream).map_err(|error| error.to_string())?
            else {
                continue;
            };
            if let Ok(ServerFrame::Event(EventFrame::Agent {
                worktree_id,
                tab_id,
                agent,
                status,
                attention_kind,
                request_id,
                ..
            })) = serde_json::from_slice::<ServerFrame>(&bytes)
            {
                self.handle_report(&Report {
                    worktree_id,
                    tab_id,
                    agent,
                    status,
                    attention_kind,
                    request_id,
                });
            }
        }
    }

    fn handle_report(&self, report: &Report) {
        let Some(status) = report.status else {
            return;
        };
        if matches!(status, AgentStatus::Running | AgentStatus::Cleared) {
            // The agent moved on, so its next completion is a new event.
            self.release(report);
            return;
        }
        if !matches!(status, AgentStatus::Done | AgentStatus::Attention) || !self.latch(report) {
            return;
        }
        // The user is at the desktop and already saw the toast and the banner.
        if self.presence.desktop_focused() {
            return;
        }
        if let Err(error) = self.push(report) {
            eprintln!("push: could not deliver an agent alert: {error}");
        }
    }

    fn push(&self, report: &Report) -> Result<(), String> {
        let tokens = self.push_tokens();
        if tokens.is_empty() {
            return Ok(());
        }
        let location = self.workspace.locate(&report.worktree_id, &report.tab_id);
        let title = alert_title(
            report.status,
            report.attention_kind,
            &self.agent_name(&report.agent),
        );
        let body = alert_body(&location);
        let data = json!({
            "worktreeId": report.worktree_id,
            "tabId": report.tab_id,
            "agent": report.agent,
        });
        let messages: Vec<PushMessage> = tokens
            .into_iter()
            .map(|token| PushMessage {
                to: token,
                title: title.clone(),
                body: body.clone(),
                data: data.clone(),
                sound: "default",
            })
            .collect();
        let dead = expo::send(&self.http, &messages)?;
        self.forget(&dead);
        Ok(())
    }

    fn push_tokens(&self) -> Vec<String> {
        self.devices
            .lock()
            .map(|devices| devices.push_tokens())
            .unwrap_or_default()
    }

    fn forget(&self, tokens: &[String]) {
        if tokens.is_empty() {
            return;
        }
        let Ok(devices) = self.devices.lock() else {
            return;
        };
        for token in tokens {
            if let Err(error) = devices.forget_push_token(token) {
                eprintln!("push: could not drop a dead token: {error}");
            }
        }
    }

    /// Records that this status has been pushed, returning whether it is new.
    /// Mirrors the desktop's alert latch: the host replays its whole status
    /// snapshot on every reconnect, so without this a reconnect would re-push
    /// completions the user has already been told about.
    fn latch(&self, report: &Report) -> bool {
        let Ok(mut latch) = self.latch.lock() else {
            return false;
        };
        let key = report.latch_key();
        let Some(status) = report.status else {
            return false;
        };
        if latch.get(&key) == Some(&status) {
            return false;
        }
        latch.insert(key, status);
        true
    }

    fn release(&self, report: &Report) {
        if let Ok(mut latch) = self.latch.lock() {
            latch.remove(&report.latch_key());
        }
    }

    /// Resolves an agent's display name from the host's plugin catalog, falling
    /// back to the reported id. Reports carry the final segment of a catalog id
    /// (`claude` for `pragma.claude`), so both forms are indexed.
    fn agent_name(&self, agent_id: &str) -> String {
        if let Some(name) = self.cached_agent_name(agent_id, false) {
            return name;
        }
        self.cached_agent_name(agent_id, true)
            .unwrap_or_else(|| agent_id.to_string())
    }

    fn cached_agent_name(&self, agent_id: &str, refresh: bool) -> Option<String> {
        let mut catalog = self.catalog.lock().ok()?;
        let stale = catalog
            .fetched_at
            .is_none_or(|fetched| fetched.elapsed() > CATALOG_TTL);
        if refresh && stale {
            catalog.names = self.fetch_agent_names();
            catalog.fetched_at = Some(Instant::now());
        }
        catalog.names.get(agent_id).cloned()
    }

    fn fetch_agent_names(&self) -> HashMap<String, String> {
        let Ok(catalog) = self.client.agent_catalog() else {
            return HashMap::new();
        };
        let Some(agents) = catalog.get("agents").and_then(Value::as_array) else {
            return HashMap::new();
        };
        let mut names = HashMap::new();
        for agent in agents {
            let (Some(id), Some(name)) = (
                agent.get("id").and_then(Value::as_str),
                agent.get("name").and_then(Value::as_str),
            ) else {
                continue;
            };
            names.insert(id.to_string(), name.to_string());
            if let Some((_, runtime_id)) = id.rsplit_once('.') {
                names
                    .entry(runtime_id.to_string())
                    .or_insert_with(|| name.to_string());
            }
        }
        names
    }
}

/// The parts of an agent event push cares about.
struct Report {
    worktree_id: String,
    tab_id: String,
    agent: String,
    status: Option<AgentStatus>,
    attention_kind: Option<AgentAttentionKind>,
    request_id: Option<String>,
}

impl Report {
    /// Identity of one alertable occurrence. A command approval is keyed by its
    /// request id too, so a second command is a second alert.
    fn latch_key(&self) -> String {
        let request_id = match self.attention_kind {
            Some(AgentAttentionKind::Command) => self.request_id.as_deref().unwrap_or_default(),
            _ => "",
        };
        format!(
            "{}\u{0}{}\u{0}{}\u{0}{request_id}",
            self.worktree_id, self.tab_id, self.agent
        )
    }
}

#[cfg(test)]
mod tests {
    use super::Report;
    use pragma_protocol::{AgentAttentionKind, AgentStatus};

    fn report(attention_kind: Option<AgentAttentionKind>, request_id: Option<&str>) -> Report {
        Report {
            worktree_id: "worktree-1".to_string(),
            tab_id: "tab-1".to_string(),
            agent: "claude".to_string(),
            status: Some(AgentStatus::Attention),
            attention_kind,
            request_id: request_id.map(str::to_string),
        }
    }

    #[test]
    fn command_approvals_key_on_their_request() {
        assert_ne!(
            report(Some(AgentAttentionKind::Command), Some("req-1")).latch_key(),
            report(Some(AgentAttentionKind::Command), Some("req-2")).latch_key()
        );
    }

    #[test]
    fn other_reports_ignore_the_request_id() {
        assert_eq!(
            report(Some(AgentAttentionKind::Question), Some("req-1")).latch_key(),
            report(Some(AgentAttentionKind::Question), Some("req-2")).latch_key()
        );
    }
}
