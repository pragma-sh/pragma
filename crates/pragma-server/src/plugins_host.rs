//! Plugin catalog host: supervises the `pragma-plugins` sidecar, caches the
//! agent catalog + icon-asset map it publishes, and serves both over the
//! `plugins` RPC domain.
//!
//! Mirrors the `automations` sidecar supervisor: a lazily (re)spawned child with
//! a stdout reader thread. The sidecar resolves plugin agent contributions in
//! TypeScript (it can `import()` plugin bundles) and reports a `catalog` event;
//! the last catalog is cached so a sidecar crash never blanks the catalog — a
//! respawn re-runs `load` and the cache holds until a fresh publish arrives.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use base64::Engine;
use pragma_constants::CONSTANTS;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

const SIDECAR_NAME: &str = "pragma-plugins";

/// File beside `daemon.sock` holding the last registered plugin roots, so a
/// server restarted while the desktop app is closed still resolves
/// project-contributed agents for headless launches.
const PLUGIN_ROOTS_FILE: &str = "plugin-roots.json";

/// Icons are capped at 256 KB so base64-in-JSON asset delivery stays cheap.
const ASSET_MAX_BYTES: u64 = 256 * 1024;
const LOAD_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Error)]
pub enum PluginsError {
    #[error("asset not found: {0}")]
    NotFound(String),
    #[error("invalid plugins request: {0}")]
    InvalidRequest(String),
    #[error("plugins operation failed: {0}")]
    Operation(String),
    #[error("plugins sidecar disconnected: {0}")]
    SidecarDisconnected(String),
    #[error("lock poisoned")]
    LockPoisoned,
}

/// One hashed icon asset the sidecar reported: where it lives + its MIME type.
#[derive(Clone, Debug, Deserialize)]
struct AssetEntry {
    path: String,
    mime: String,
}

/// One watcher a plugin attaches to an agent, as reported by the sidecar.
/// Server-internal: the `config` may hold plugin secrets, so watcher specs are
/// cached beside — never inside — the catalog the gateway serves to clients.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatcherSpec {
    /// Plugin the watcher belongs to (stable catalog plugin id).
    pub plugin_id: String,
    /// Agent id the watcher attaches to.
    pub agent_id: String,
    /// Agent id used to select the watcher inside the plugin bundle.
    pub watcher_agent: String,
    /// Absolute path of the plugin bundle `pragma-watch` imports.
    pub main_path: String,
    /// The plugin's config, forwarded verbatim to the watcher instance.
    pub config: Value,
}

/// How far catalog loading has progressed. A load sent before the gateway
/// discovery file exists resolves only static-model agents (dynamic model
/// providers shell out through the gateway and fail), so it must be retried
/// once gateway credentials appear.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LoadState {
    NotStarted,
    StartedWithoutGateway,
    StartedWithGateway,
}

/// Events emitted by the `pragma-plugins` sidecar on stdout.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum SidecarEvent {
    Ready,
    Catalog {
        catalog: Value,
        #[serde(default)]
        assets: HashMap<String, AssetEntry>,
        #[serde(default)]
        watchers: Vec<WatcherSpec>,
    },
    Error {
        #[serde(default)]
        error: Option<String>,
    },
    Log {
        #[serde(default)]
        message: Option<String>,
    },
}

/// Owns the supervised sidecar plus the cached catalog + asset map.
pub struct PluginsRegistry {
    server_dir: PathBuf,
    sidecar: PluginsSidecar,
    catalog: Arc<Mutex<Value>>,
    assets: Arc<Mutex<HashMap<String, AssetEntry>>>,
    watchers: Arc<Mutex<Vec<WatcherSpec>>>,
    publish_revision: Arc<(Mutex<u64>, Condvar)>,
    roots: Mutex<Vec<String>>,
    load_state: Mutex<LoadState>,
}

impl PluginsRegistry {
    pub fn new(server_dir: PathBuf) -> Arc<Self> {
        let (tx, rx) = mpsc::channel();
        let catalog = Arc::new(Mutex::new(json!({ "agents": [] })));
        let assets = Arc::new(Mutex::new(HashMap::new()));
        let watchers = Arc::new(Mutex::new(Vec::new()));
        let publish_revision = Arc::new((Mutex::new(0), Condvar::new()));
        let roots = load_persisted_roots(&server_dir);
        let registry = Arc::new(Self {
            server_dir,
            sidecar: PluginsSidecar::new(tx),
            catalog: Arc::clone(&catalog),
            assets: Arc::clone(&assets),
            watchers: Arc::clone(&watchers),
            publish_revision: Arc::clone(&publish_revision),
            roots: Mutex::new(roots),
            load_state: Mutex::new(LoadState::NotStarted),
        });
        thread::spawn(move || {
            for event in rx {
                match event {
                    SidecarEvent::Catalog {
                        catalog: fresh,
                        assets: fresh_assets,
                        watchers: fresh_watchers,
                    } => {
                        if let Ok(mut guard) = catalog.lock() {
                            *guard = fresh;
                        }
                        if let Ok(mut guard) = assets.lock() {
                            *guard = fresh_assets;
                        }
                        if let Ok(mut guard) = watchers.lock() {
                            *guard = fresh_watchers;
                        }
                        let (revision, changed) = &*publish_revision;
                        if let Ok(mut revision) = revision.lock() {
                            *revision += 1;
                            changed.notify_all();
                        }
                    }
                    SidecarEvent::Error { error } => {
                        eprintln!(
                            "pragma-plugins sidecar error: {}",
                            error.unwrap_or_default()
                        );
                    }
                    SidecarEvent::Log { message } => {
                        if let Some(message) = message {
                            eprintln!("pragma-plugins: {message}");
                        }
                    }
                    SidecarEvent::Ready => {}
                }
            }
        });
        registry
    }

    /// Handles a `plugins` RPC: `catalog`, `registerRoots`, `readAsset`, `reload`.
    pub fn handle_rpc(&self, payload: &Value) -> Result<Value, PluginsError> {
        let action = payload
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match action {
            "catalog" => {
                self.ensure_catalog_fresh()?;
                Ok(self.cached_catalog()?)
            }
            "registerRoots" => {
                self.register_roots(payload)?;
                Ok(json!({ "ok": true }))
            }
            "readAsset" => self.read_asset(payload),
            "reload" => {
                self.reload()?;
                Ok(json!({ "ok": true }))
            }
            other => Err(PluginsError::InvalidRequest(format!(
                "unknown plugins action: {other}"
            ))),
        }
    }

    fn cached_catalog(&self) -> Result<Value, PluginsError> {
        Ok(self
            .catalog
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?
            .clone())
    }

    /// Handles server-only plugin RPC actions whose payloads must never cross
    /// the public gateway boundary.
    pub fn handle_internal_rpc(&self, payload: &Value) -> Result<Value, PluginsError> {
        let action = payload
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if action != "watcher" {
            return Err(PluginsError::InvalidRequest(format!(
                "unknown internal plugins action: {action}"
            )));
        }
        let agent_id = payload
            .get("agentId")
            .and_then(Value::as_str)
            .ok_or_else(|| PluginsError::InvalidRequest("missing agentId".to_string()))?;
        let plugin_id = payload.get("pluginId").and_then(Value::as_str);
        self.ensure_catalog_fresh()?;
        let watcher = self
            .watchers
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?
            .iter()
            .find(|watcher| {
                watcher.agent_id == agent_id && plugin_id.is_none_or(|id| watcher.plugin_id == id)
            })
            .cloned();
        serde_json::to_value(watcher)
            .map_err(|error| PluginsError::Operation(format!("serialize watcher: {error}")))
    }

    fn register_roots(&self, payload: &Value) -> Result<(), PluginsError> {
        let roots: Vec<String> = payload
            .get("roots")
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default();
        persist_roots(&self.server_dir, &roots);
        (*self.roots.lock().map_err(|_| PluginsError::LockPoisoned)?).clone_from(&roots);
        self.reload()
    }

    /// Re-sends `load` with the current roots and freshly read gateway
    /// credentials (e.g. after the gateway starts and writes its discovery
    /// file, so dynamic model providers can finally resolve).
    fn reload(&self) -> Result<(), PluginsError> {
        let roots = self
            .roots
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?
            .clone();
        let (revision, changed) = &*self.publish_revision;
        let previous = *revision.lock().map_err(|_| PluginsError::LockPoisoned)?;
        let state = self.send_load(&roots)?;
        let (revision, timeout) = changed
            .wait_timeout_while(
                revision.lock().map_err(|_| PluginsError::LockPoisoned)?,
                LOAD_TIMEOUT,
                |revision| *revision == previous,
            )
            .map_err(|_| PluginsError::LockPoisoned)?;
        if timeout.timed_out() && *revision == previous {
            return Err(PluginsError::Operation(
                "timed out waiting for plugin catalog".to_string(),
            ));
        }
        *self
            .load_state
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)? = state;
        Ok(())
    }

    /// Starts catalog assembly on first read, and retries it once gateway
    /// credentials appear when the first load ran without them (a credential-less
    /// load drops every agent whose model provider needs the gateway).
    fn ensure_catalog_fresh(&self) -> Result<(), PluginsError> {
        let state = *self
            .load_state
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?;
        match state {
            LoadState::StartedWithGateway => Ok(()),
            LoadState::StartedWithoutGateway if self.gateway_credentials().is_none() => Ok(()),
            LoadState::NotStarted | LoadState::StartedWithoutGateway => self.reload(),
        }
    }

    fn send_load(&self, roots: &[String]) -> Result<LoadState, PluginsError> {
        let credentials = self.gateway_credentials();
        let state = if credentials.is_some() {
            LoadState::StartedWithGateway
        } else {
            LoadState::StartedWithoutGateway
        };
        let (gateway_url, gateway_token) = credentials.unwrap_or_default();
        self.sidecar.send(&json!({
            "type": "load",
            "roots": roots,
            "bundledDir": bundled_plugins_dir(),
            "gatewayUrl": gateway_url,
            "gatewayToken": gateway_token,
        }))?;
        Ok(state)
    }

    /// Reads the gateway `(url, token)` from the discovery file beside the
    /// socket, or `None` before the gateway has started. A credential-less load
    /// still resolves agents with static models; [`Self::ensure_catalog_fresh`]
    /// retries once credentials appear so gateway-dependent agents recover.
    fn gateway_credentials(&self) -> Option<(String, String)> {
        let path = self
            .server_dir
            .join(CONSTANTS.gateway.discovery_file.as_str());
        let contents = fs::read_to_string(path).ok()?;
        let value = serde_json::from_str::<Value>(&contents).ok()?;
        let port = value.get("port").and_then(Value::as_u64)?;
        let token = value.get("token").and_then(Value::as_str)?;
        if port == 0 || token.is_empty() {
            return None;
        }
        Some((format!("http://127.0.0.1:{port}"), token.to_string()))
    }

    fn read_asset(&self, payload: &Value) -> Result<Value, PluginsError> {
        let hash = payload
            .get("hash")
            .and_then(Value::as_str)
            .ok_or_else(|| PluginsError::InvalidRequest("missing asset hash".to_string()))?;
        if !is_lowercase_hex_sha256(hash) {
            return Err(PluginsError::InvalidRequest(format!(
                "invalid asset hash: {hash}"
            )));
        }
        let entry = self
            .assets
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?
            .get(hash)
            .cloned()
            .ok_or_else(|| PluginsError::NotFound(hash.to_string()))?;
        let metadata = fs::metadata(&entry.path)
            .map_err(|err| PluginsError::Operation(format!("stat asset: {err}")))?;
        if metadata.len() > ASSET_MAX_BYTES {
            return Err(PluginsError::Operation(format!(
                "asset exceeds {ASSET_MAX_BYTES} byte cap"
            )));
        }
        let bytes = fs::read(&entry.path)
            .map_err(|err| PluginsError::Operation(format!("read asset: {err}")))?;
        let base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(json!({ "base64": base64, "mime": entry.mime }))
    }
}

/// Reads the persisted plugin roots, or an empty list before the first
/// `registerRoots` (or when the file is unreadable/corrupt — bundled agents
/// still resolve without roots).
fn load_persisted_roots(server_dir: &Path) -> Vec<String> {
    fs::read_to_string(server_dir.join(PLUGIN_ROOTS_FILE))
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

/// Persists the registered plugin roots beside the socket. Best-effort: a
/// failed write only costs project-plugin agents after a server restart.
fn persist_roots(server_dir: &Path, roots: &[String]) {
    let Ok(contents) = serde_json::to_string(roots) else {
        return;
    };
    if let Err(error) = fs::write(server_dir.join(PLUGIN_ROOTS_FILE), contents) {
        eprintln!("failed to persist plugin roots: {error}");
    }
}

/// True when `value` is a lowercase-hex sha256 (64 hex chars). Guards the asset
/// route: the hash is only ever a map key, never interpreted as a path.
fn is_lowercase_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The supervised `pragma-plugins` child, respawned lazily on send.
struct PluginsSidecar {
    tx: Sender<SidecarEvent>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

impl PluginsSidecar {
    fn new(tx: Sender<SidecarEvent>) -> Self {
        Self {
            tx,
            child: Mutex::new(None),
            stdin: Mutex::new(None),
        }
    }

    fn send(&self, command: &Value) -> Result<(), PluginsError> {
        self.ensure_running()?;
        let result = {
            let mut stdin = self.stdin.lock().map_err(|_| PluginsError::LockPoisoned)?;
            let Some(stdin) = stdin.as_mut() else {
                return Err(PluginsError::SidecarDisconnected(
                    "plugins sidecar stdin unavailable".to_string(),
                ));
            };
            writeln!(stdin, "{command}").and_then(|()| stdin.flush())
        };
        match result {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::BrokenPipe => {
                self.reset()?;
                Err(PluginsError::SidecarDisconnected(err.to_string()))
            }
            Err(err) => Err(PluginsError::Operation(format!(
                "write sidecar command: {err}"
            ))),
        }
    }

    fn reset(&self) -> Result<(), PluginsError> {
        let child = {
            let mut child = self.child.lock().map_err(|_| PluginsError::LockPoisoned)?;
            let child = child.take();
            self.stdin
                .lock()
                .map_err(|_| PluginsError::LockPoisoned)?
                .take();
            child
        };
        if let Some(mut child) = child {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    fn clear_exited_child(&self) -> Result<bool, PluginsError> {
        let mut child = self.child.lock().map_err(|_| PluginsError::LockPoisoned)?;
        let Some(process) = child.as_mut() else {
            return Ok(false);
        };
        let Some(status) = process
            .try_wait()
            .map_err(|err| PluginsError::Operation(format!("poll plugins sidecar: {err}")))?
        else {
            return Ok(false);
        };
        eprintln!("plugins sidecar exited: {status}");
        child.take();
        self.stdin
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?
            .take();
        Ok(true)
    }

    fn ensure_running(&self) -> Result<(), PluginsError> {
        let has_child = self
            .child
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?
            .is_some();
        if has_child && !self.clear_exited_child()? {
            return Ok(());
        }
        let mut command = sidecar_command();
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|err| PluginsError::Operation(format!("spawn plugins sidecar: {err}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| PluginsError::Operation("plugins sidecar stdin missing".to_string()))?;
        if let Some(stdout) = child.stdout.take() {
            let tx = self.tx.clone();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    match serde_json::from_str::<SidecarEvent>(&line) {
                        Ok(event) => {
                            let _ = tx.send(event);
                        }
                        Err(err) => {
                            eprintln!("plugins sidecar emitted invalid JSON: {err}: {line}");
                        }
                    }
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    eprintln!("plugins sidecar: {line}");
                }
            });
        }
        *self.stdin.lock().map_err(|_| PluginsError::LockPoisoned)? = Some(stdin);
        *self.child.lock().map_err(|_| PluginsError::LockPoisoned)? = Some(child);
        Ok(())
    }
}

fn sidecar_command() -> Command {
    if cfg!(debug_assertions) {
        let mut command = Command::new("bun");
        command
            .arg("packages/plugins-host/src/cli.ts")
            .current_dir(workspace_root());
        command
    } else {
        Command::new(sidecar_executable(SIDECAR_NAME))
    }
}

/// Resolves the directory of plugin bundles shipped with the app. Dev reads
/// the staged copies under the workspace `src-tauri/resources`; a release
/// build reads them from the app resource dir the desktop forwarded via
/// `PRAGMA_RESOURCE_DIR` when it spawned this server. `None` (no watcher /
/// bundled agents, non-fatal) when neither location exists.
pub fn bundled_plugins_dir() -> Option<PathBuf> {
    let rel = Path::new(CONSTANTS.plugins.bundled_dir_name.as_str());
    if cfg!(debug_assertions) {
        let dir = workspace_root()
            .join("apps/pragma/src-tauri/resources")
            .join(rel);
        return dir.is_dir().then_some(dir);
    }
    std::env::var_os("PRAGMA_RESOURCE_DIR")
        .map(PathBuf::from)
        .into_iter()
        .flat_map(|dir| [dir.join("resources").join(rel), dir.join(rel)])
        .find(|candidate| candidate.is_dir())
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
    use super::{is_lowercase_hex_sha256, PluginsRegistry, SidecarEvent};

    #[test]
    fn validates_lowercase_hex_sha256() {
        assert!(is_lowercase_hex_sha256(&"a".repeat(64)));
        assert!(is_lowercase_hex_sha256(&"0123456789abcdef".repeat(4)));
        assert!(
            !is_lowercase_hex_sha256(&"A".repeat(64)),
            "uppercase rejected"
        );
        assert!(!is_lowercase_hex_sha256("abc"), "wrong length rejected");
        assert!(
            !is_lowercase_hex_sha256(&"g".repeat(64)),
            "non-hex rejected"
        );
        assert!(!is_lowercase_hex_sha256("../etc/passwd"), "path rejected");
    }

    #[test]
    fn parses_catalog_event() {
        let event: SidecarEvent = serde_json::from_str(
            r#"{"type":"catalog","catalog":{"agents":[]},"assets":{"abc":{"path":"/x.svg","mime":"image/svg+xml"}}}"#,
        )
        .expect("catalog event must parse");
        assert!(matches!(event, SidecarEvent::Catalog { .. }));
    }

    #[test]
    fn gateway_credentials_require_a_real_port_and_token() {
        let dir =
            std::env::temp_dir().join(format!("pragma-plugins-creds-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create test dir");
        let registry = PluginsRegistry::new(dir.clone());
        let discovery = dir.join(pragma_constants::CONSTANTS.gateway.discovery_file.as_str());
        assert!(
            registry.gateway_credentials().is_none(),
            "missing discovery file yields no credentials"
        );
        std::fs::write(&discovery, r#"{"port":0,"token":""}"#).expect("write discovery");
        assert!(
            registry.gateway_credentials().is_none(),
            "zero port / empty token yields no credentials"
        );
        std::fs::write(&discovery, r#"{"port":4242,"token":"abc"}"#).expect("write discovery");
        assert_eq!(
            registry.gateway_credentials(),
            Some(("http://127.0.0.1:4242".to_string(), "abc".to_string()))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn caches_empty_catalog_before_any_publish() {
        let dir = std::env::temp_dir().join(format!("pragma-plugins-test-{}", std::process::id()));
        let registry = PluginsRegistry::new(dir);
        let catalog = registry.cached_catalog().expect("cached catalog");
        assert_eq!(catalog, serde_json::json!({ "agents": [] }));
    }

    #[test]
    fn read_asset_rejects_a_bad_hash() {
        let dir = std::env::temp_dir().join(format!("pragma-plugins-test-{}", std::process::id()));
        let registry = PluginsRegistry::new(dir);
        let result = registry.handle_rpc(&serde_json::json!({
            "action": "readAsset",
            "hash": "../../etc/passwd",
        }));
        assert!(result.is_err());
    }
}
