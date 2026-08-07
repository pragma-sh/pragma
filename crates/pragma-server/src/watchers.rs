//! Supervision of the per-agent-session `pragma-watch` sidecars.
//!
//! A watcher subscribes to gateway agent events and delivers chat
//! interjections, question answers, approval verdicts, and interrupts into an
//! agent's TUI. Without one, a paired phone's replies reach this server and
//! stop there — the desktop never notices, because typing into the terminal
//! bypasses the whole path.
//!
//! Watchers are owned **here**, not by the desktop, because that is where the
//! sessions live. The desktop used to spawn them from its plugin registry,
//! which tied a watcher's lifetime to a frontend that restarts, switches
//! projects, and reloads plugins far more often than a session ends: every one
//! of those events silently orphaned every running agent. This module instead
//! reconciles the live set on a timer — one watcher per live agent session —
//! so a watcher that was never started, exited, or is pointed at a stale
//! gateway is replaced within [`RECONCILE_INTERVAL`].
//!
//! Watcher resolution is catalog-driven: the plugin catalog sidecar reports a
//! watcher spec (bundle path + config) for every plugin that declares one, so
//! any installed agent plugin — bundled with the app or user-configured — gets
//! its watcher with no per-plugin code here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use pragma_constants::CONSTANTS;
use serde_json::Value;

use crate::plugins_host::{PluginsRegistry, WatcherSpec};

/// How often the live watcher set is reconciled against live agent sessions.
pub const RECONCILE_INTERVAL: Duration = Duration::from_secs(5);

/// A watcher that exits sooner than this after spawning is treated as failing
/// (bad bundle, unreachable gateway) and backed off rather than hot-looped.
const HEALTHY_UPTIME: Duration = Duration::from_secs(30);
/// First backoff after a failed watcher, doubled per consecutive failure.
const BACKOFF_BASE: Duration = Duration::from_secs(5);
/// Ceiling for the spawn backoff, so a permanently-broken plugin costs one
/// spawn every few minutes instead of one every reconcile tick.
const BACKOFF_MAX: Duration = Duration::from_mins(5);

/// One agent session that must have a watcher attached.
// The shared `_id` suffix is the workspace vocabulary these fields are copied
// from (`Tab::id`, `Tab::worktree_id`, `Tab::agent_id`); dropping it here would
// make the mapping harder to read, not easier.
#[allow(clippy::struct_field_names)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesiredWatcher {
    /// Session/tab id — the two are the same for agent sessions.
    pub tab_id: String,
    pub worktree_id: String,
    /// Catalog agent id recorded on the tab (e.g. `pragma.claude-code`).
    pub agent_id: String,
}

/// Gateway credentials a watcher was started with. A gateway restart binds a
/// fresh ephemeral port, which pins every already-running watcher to a dead
/// address; comparing these against the current discovery file is what makes a
/// stale watcher get replaced instead of retrying forever in silence.
#[derive(Clone, Debug, PartialEq, Eq)]
struct GatewayCredentials {
    url: String,
    token: String,
}

struct WatcherChild {
    agent_id: String,
    gateway: GatewayCredentials,
    started: Instant,
    child: Child,
}

#[derive(Default)]
struct SpawnBackoff {
    failures: u32,
    last_attempt: Option<Instant>,
}

impl SpawnBackoff {
    fn ready(&self) -> bool {
        let Some(last) = self.last_attempt else {
            return true;
        };
        if self.failures == 0 {
            return true;
        }
        let delay = BACKOFF_BASE
            .saturating_mul(1_u32 << (self.failures - 1).min(6))
            .min(BACKOFF_MAX);
        last.elapsed() >= delay
    }
}

/// Owns every watcher process this server started, keyed by session/tab id.
pub struct WatcherSupervisor {
    server_dir: PathBuf,
    children: Mutex<HashMap<String, WatcherChild>>,
    backoff: Mutex<HashMap<String, SpawnBackoff>>,
}

impl WatcherSupervisor {
    pub fn new(server_dir: PathBuf) -> Self {
        Self {
            server_dir,
            children: Mutex::new(HashMap::new()),
            backoff: Mutex::new(HashMap::new()),
        }
    }

    /// Brings the running watcher set in line with `desired`: reaps exited
    /// children, stops watchers whose session ended or whose agent changed,
    /// replaces watchers holding stale gateway credentials, and starts the
    /// missing ones. Best-effort throughout — a watcher that cannot start logs
    /// and is retried with backoff; the agent session itself keeps running.
    pub fn reconcile(&self, plugins: &PluginsRegistry, desired: &[DesiredWatcher]) {
        let gateway = gateway_credentials(&self.server_dir);
        let Ok(mut children) = self.children.lock() else {
            return;
        };
        self.reap_exited(&mut children);
        retain_desired(&mut children, desired, gateway.as_ref());
        let Some(gateway) = gateway else {
            if !desired.is_empty() && !children.is_empty() {
                // Only noteworthy while watchers are already running: at
                // startup the gateway routinely appears a moment later.
                eprintln!("watchers: gateway discovery is unavailable; not starting watchers");
            }
            return;
        };
        for entry in desired {
            if children.contains_key(&entry.tab_id) {
                continue;
            }
            if !self.backoff_ready(&entry.tab_id) {
                continue;
            }
            match Self::spawn(plugins, entry, &gateway) {
                Some(child) => {
                    children.insert(entry.tab_id.clone(), child);
                }
                None => self.record_failure(&entry.tab_id),
            }
        }
    }

    /// Drops children that already exited, recording whether they died fast
    /// enough to count as a failure for backoff purposes.
    fn reap_exited(&self, children: &mut HashMap<String, WatcherChild>) {
        let exited: Vec<String> = children
            .iter_mut()
            .filter_map(|(tab_id, entry)| {
                matches!(entry.child.try_wait(), Ok(Some(_)) | Err(_)).then(|| tab_id.clone())
            })
            .collect();
        for tab_id in exited {
            let Some(entry) = children.remove(&tab_id) else {
                continue;
            };
            if entry.started.elapsed() < HEALTHY_UPTIME {
                eprintln!(
                    "watchers: watcher for {} ({}) exited after {:?}; agent replies from a phone \
                     will not reach it until it restarts",
                    tab_id,
                    entry.agent_id,
                    entry.started.elapsed()
                );
                self.record_failure(&tab_id);
            } else {
                self.clear_failures(&tab_id);
            }
        }
    }

    fn backoff_ready(&self, tab_id: &str) -> bool {
        self.backoff
            .lock()
            .ok()
            .is_none_or(|backoff| backoff.get(tab_id).is_none_or(SpawnBackoff::ready))
    }

    fn record_failure(&self, tab_id: &str) {
        if let Ok(mut backoff) = self.backoff.lock() {
            let entry = backoff.entry(tab_id.to_string()).or_default();
            entry.failures = entry.failures.saturating_add(1);
            entry.last_attempt = Some(Instant::now());
        }
    }

    fn clear_failures(&self, tab_id: &str) {
        if let Ok(mut backoff) = self.backoff.lock() {
            backoff.remove(tab_id);
        }
    }

    /// Starts one watcher, returning `None` when the plugin declares none, the
    /// bundle is missing, or the process could not be spawned.
    fn spawn(
        plugins: &PluginsRegistry,
        entry: &DesiredWatcher,
        gateway: &GatewayCredentials,
    ) -> Option<WatcherChild> {
        let watcher = watcher_spec(plugins, &entry.agent_id)?;
        if !Path::new(&watcher.main_path).is_file() {
            eprintln!(
                "watchers: bundle missing at {} for agent {}; phone replies cannot reach it",
                watcher.main_path, entry.agent_id
            );
            return None;
        }
        let mut command = watcher_command();
        command
            .args(["--pluginId", &watcher.plugin_id])
            .args(["--pluginMain", &watcher.main_path])
            .args(["--agentId", &watcher.watcher_agent])
            .args(["--watcherAgent", &watcher.watcher_agent])
            .args(["--config", &watcher.config.to_string()])
            .args(["--sessionId", &entry.tab_id])
            .args(["--tabId", &entry.tab_id])
            .args(["--worktreeId", &entry.worktree_id])
            .args(["--gatewayUrl", &gateway.url])
            .args(["--gatewayToken", &gateway.token])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        match command.spawn() {
            Ok(child) => Some(WatcherChild {
                agent_id: entry.agent_id.clone(),
                gateway: gateway.clone(),
                started: Instant::now(),
                child,
            }),
            Err(error) => {
                eprintln!(
                    "watchers: failed to spawn watcher for agent {}: {error}",
                    entry.agent_id
                );
                None
            }
        }
    }
}

/// Stops watchers whose session is gone, whose tab now hosts a different
/// agent, or that hold gateway credentials the current discovery file has
/// superseded.
fn retain_desired(
    children: &mut HashMap<String, WatcherChild>,
    desired: &[DesiredWatcher],
    gateway: Option<&GatewayCredentials>,
) {
    let stale: Vec<String> = children
        .iter()
        .filter(|(tab_id, entry)| {
            !is_current(tab_id, &entry.agent_id, &entry.gateway, desired, gateway)
        })
        .map(|(tab_id, _)| tab_id.clone())
        .collect();
    for tab_id in stale {
        if let Some(mut entry) = children.remove(&tab_id) {
            stop_child(&mut entry.child);
        }
    }
}

/// Whether a running watcher still matches reality: its session is still a
/// desired agent session, that session still hosts the same agent, and its
/// gateway credentials are the ones the discovery file currently advertises.
/// An unreadable discovery file (`None`) leaves watchers alone — a transient
/// read failure must not tear down working watchers.
fn is_current(
    tab_id: &str,
    agent_id: &str,
    watcher_gateway: &GatewayCredentials,
    desired: &[DesiredWatcher],
    gateway: Option<&GatewayCredentials>,
) -> bool {
    let wanted = desired
        .iter()
        .find(|candidate| candidate.tab_id == tab_id)
        .is_some_and(|candidate| candidate.agent_id == agent_id);
    wanted && gateway.is_none_or(|gateway| gateway == watcher_gateway)
}

fn stop_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Resolves the plugin-declared watcher for one catalog agent id.
fn watcher_spec(plugins: &PluginsRegistry, agent_id: &str) -> Option<WatcherSpec> {
    let payload = serde_json::json!({ "action": "watcher", "agentId": agent_id });
    plugins
        .handle_internal_rpc(&payload)
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
}

/// Reads the gateway `(url, token)` from the discovery file beside the socket.
/// Mirrors the plugins host's credential read.
fn gateway_credentials(server_dir: &Path) -> Option<GatewayCredentials> {
    let path = server_dir.join(CONSTANTS.gateway.discovery_file.as_str());
    let contents = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&contents).ok()?;
    let port = value.get("port").and_then(Value::as_u64)?;
    let token = value.get("token").and_then(Value::as_str)?;
    if port == 0 || token.is_empty() {
        return None;
    }
    Some(GatewayCredentials {
        url: format!("http://127.0.0.1:{port}"),
        token: token.to_string(),
    })
}

/// The `pragma-watch` invocation: dev runs the workspace CLI through bun,
/// release runs the bundled sidecar beside this server binary.
fn watcher_command() -> Command {
    if cfg!(debug_assertions) {
        let mut command = pragma_platform::process::command("bun");
        command
            .arg(workspace_root().join("packages/watcher/src/cli.ts"))
            .current_dir(workspace_root());
        command
    } else {
        pragma_platform::process::command(sidecar_executable("pragma-watch"))
    }
}

fn sidecar_executable(name: &str) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|parent| parent.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
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
    use std::time::{Duration, Instant};

    use super::{
        gateway_credentials, is_current, DesiredWatcher, GatewayCredentials, SpawnBackoff,
    };

    fn credentials(port: u16) -> GatewayCredentials {
        GatewayCredentials {
            url: format!("http://127.0.0.1:{port}"),
            token: "token".to_string(),
        }
    }

    fn desired(tab_id: &str, agent_id: &str) -> DesiredWatcher {
        DesiredWatcher {
            tab_id: tab_id.to_string(),
            worktree_id: "worktree".to_string(),
            agent_id: agent_id.to_string(),
        }
    }

    #[test]
    fn gateway_credentials_require_a_live_discovery_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(gateway_credentials(dir.path()).is_none());
        std::fs::write(
            dir.path()
                .join(pragma_constants::CONSTANTS.gateway.discovery_file.as_str()),
            r#"{"port":4242,"token":"abc"}"#,
        )
        .expect("write discovery");
        let resolved = gateway_credentials(dir.path()).expect("credentials");
        assert_eq!(resolved.url, "http://127.0.0.1:4242");
        assert_eq!(resolved.token, "abc");
    }

    #[test]
    fn keeps_a_watcher_whose_session_and_gateway_are_unchanged() {
        let gateway = credentials(1234);
        assert!(is_current(
            "tab",
            "pragma.x",
            &gateway,
            &[desired("tab", "pragma.x")],
            Some(&gateway),
        ));
    }

    #[test]
    fn replaces_a_watcher_whose_session_ended() {
        let gateway = credentials(1234);
        assert!(!is_current(
            "tab",
            "pragma.x",
            &gateway,
            &[],
            Some(&gateway)
        ));
    }

    /// The regression this module exists for: a gateway restart rebinds an
    /// ephemeral port, so a watcher started against the old one can never be
    /// reached again and must be replaced rather than left running against a
    /// dead address.
    #[test]
    fn replaces_a_watcher_pinned_to_a_superseded_gateway_port() {
        assert!(!is_current(
            "tab",
            "pragma.x",
            &credentials(1234),
            &[desired("tab", "pragma.x")],
            Some(&credentials(5678)),
        ));
    }

    #[test]
    fn replaces_a_watcher_whose_tab_switched_agents() {
        let gateway = credentials(1234);
        assert!(!is_current(
            "tab",
            "pragma.x",
            &gateway,
            &[desired("tab", "pragma.y")],
            Some(&gateway),
        ));
    }

    /// An unreadable discovery file must not be read as "every watcher is stale".
    #[test]
    fn keeps_watchers_when_gateway_discovery_is_unreadable() {
        assert!(is_current(
            "tab",
            "pragma.x",
            &credentials(1234),
            &[desired("tab", "pragma.x")],
            None,
        ));
    }

    #[test]
    fn backoff_delays_a_retry_after_a_failure() {
        assert!(SpawnBackoff::default().ready());
        let failed = SpawnBackoff {
            failures: 1,
            last_attempt: Some(Instant::now()),
        };
        assert!(!failed.ready());
        let elapsed = SpawnBackoff {
            failures: 1,
            last_attempt: Instant::now().checked_sub(Duration::from_mins(1)),
        };
        assert!(elapsed.ready());
    }
}
