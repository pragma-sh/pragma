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
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine;
use pragma_constants::CONSTANTS;
use serde::Deserialize;
use serde_json::{json, Value};
use thiserror::Error;

const SIDECAR_NAME: &str = "pragma-plugins";

/// Icons are capped at 256 KB so base64-in-JSON asset delivery stays cheap.
const ASSET_MAX_BYTES: u64 = 256 * 1024;

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

/// Events emitted by the `pragma-plugins` sidecar on stdout.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum SidecarEvent {
    Ready,
    Catalog {
        catalog: Value,
        #[serde(default)]
        assets: HashMap<String, AssetEntry>,
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
    roots: Mutex<Vec<String>>,
}

impl PluginsRegistry {
    pub fn new(server_dir: PathBuf) -> Arc<Self> {
        let (tx, rx) = mpsc::channel();
        let catalog = Arc::new(Mutex::new(json!({ "agents": [] })));
        let assets = Arc::new(Mutex::new(HashMap::new()));
        let registry = Arc::new(Self {
            server_dir,
            sidecar: PluginsSidecar::new(tx),
            catalog: Arc::clone(&catalog),
            assets: Arc::clone(&assets),
            roots: Mutex::new(Vec::new()),
        });
        thread::spawn(move || {
            for event in rx {
                match event {
                    SidecarEvent::Catalog {
                        catalog: fresh,
                        assets: fresh_assets,
                    } => {
                        if let Ok(mut guard) = catalog.lock() {
                            *guard = fresh;
                        }
                        if let Ok(mut guard) = assets.lock() {
                            *guard = fresh_assets;
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
            "catalog" => Ok(self.cached_catalog()?),
            "registerRoots" => {
                self.register_roots(payload)?;
                Ok(json!({ "ok": true }))
            }
            "readAsset" => self.read_asset(payload),
            "reload" => {
                self.sidecar.send(&json!({ "type": "reload" }))?;
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

    fn register_roots(&self, payload: &Value) -> Result<(), PluginsError> {
        let roots: Vec<String> = payload
            .get("roots")
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default();
        (*self.roots.lock().map_err(|_| PluginsError::LockPoisoned)?).clone_from(&roots);
        self.send_load(&roots)
    }

    fn send_load(&self, roots: &[String]) -> Result<(), PluginsError> {
        let (gateway_url, gateway_token) = self.gateway_credentials();
        self.sidecar.send(&json!({
            "type": "load",
            "roots": roots,
            "gatewayUrl": gateway_url,
            "gatewayToken": gateway_token,
        }))
    }

    /// Reads the gateway port + token from the discovery file beside the socket.
    /// A missing gateway yields empty credentials; agents with static models
    /// still resolve, and a later reload refreshes those needing the gateway.
    fn gateway_credentials(&self) -> (String, String) {
        let path = self
            .server_dir
            .join(CONSTANTS.gateway.discovery_file.as_str());
        let Ok(contents) = fs::read_to_string(path) else {
            return (String::new(), String::new());
        };
        let Ok(value) = serde_json::from_str::<Value>(&contents) else {
            return (String::new(), String::new());
        };
        let port = value
            .get("port")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let token = value
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        (format!("http://127.0.0.1:{port}"), token)
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
    fn caches_empty_catalog_before_any_publish() {
        let dir = std::env::temp_dir().join(format!("pragma-plugins-test-{}", std::process::id()));
        let registry = PluginsRegistry::new(dir);
        let catalog = registry
            .handle_rpc(&serde_json::json!({ "action": "catalog" }))
            .expect("catalog rpc");
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
