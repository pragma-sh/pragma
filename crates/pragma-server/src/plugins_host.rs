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
use std::sync::mpsc::{self, Sender, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;
use std::time::Instant;

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
// Dynamic model providers execute host CLIs and routinely exceed the normal
// request timeout on a cold start. Timing out too early leaves load state at
// `NotStarted`, causing every catalog caller to enqueue another full reload.
const LOAD_TIMEOUT: Duration = Duration::from_secs(30);
const USAGE_LIMITS_LOG_FIELD_MAX_CHARS: usize = 2_000;
#[cfg(not(test))]
const INITIAL_GATEWAY_WAIT: Duration = Duration::from_secs(5);

type UsageLimitsSender = SyncSender<Result<Value, String>>;
type PendingUsageLimits = Arc<Mutex<HashMap<String, UsageLimitsSender>>>;

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

/// One hashed icon asset the sidecar reported: its bytes, its MIME type, and
/// the file they came from.
#[derive(Clone, Debug, Deserialize)]
struct AssetEntry {
    path: String,
    mime: String,
    /// The icon's bytes, base64, as read when the sidecar hashed it. Absent
    /// only from an older sidecar, which the path read below still covers.
    #[serde(default)]
    base64: Option<String>,
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
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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
    UsageLimits {
        request_id: String,
        #[serde(default)]
        providers: Option<Value>,
        #[serde(default)]
        error: Option<String>,
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
    pending_usage_limits: PendingUsageLimits,
    /// Last readings per scope root (`""` for the global scope).
    usage_cache: Mutex<HashMap<String, UsageScopeCache>>,
    /// One refresh at a time per scope, so concurrent clients coalesce.
    usage_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    roots: Mutex<Vec<String>>,
    load_state: Mutex<LoadState>,
    reload_lock: Mutex<()>,
    server_boot_id: String,
}

impl PluginsRegistry {
    pub fn new(server_dir: PathBuf) -> Arc<Self> {
        let (tx, rx) = mpsc::channel();
        let catalog = Arc::new(Mutex::new(json!({ "agents": [] })));
        let assets = Arc::new(Mutex::new(HashMap::new()));
        let watchers = Arc::new(Mutex::new(Vec::new()));
        let publish_revision = Arc::new((Mutex::new(0), Condvar::new()));
        let pending_usage_limits = Arc::new(Mutex::new(HashMap::new()));
        let roots = load_persisted_roots(&server_dir);
        let registry = Arc::new(Self {
            server_dir,
            sidecar: PluginsSidecar::new(tx),
            catalog: Arc::clone(&catalog),
            assets: Arc::clone(&assets),
            watchers: Arc::clone(&watchers),
            publish_revision: Arc::clone(&publish_revision),
            pending_usage_limits: Arc::clone(&pending_usage_limits),
            usage_cache: Mutex::new(HashMap::new()),
            usage_locks: Mutex::new(HashMap::new()),
            roots: Mutex::new(roots),
            load_state: Mutex::new(LoadState::NotStarted),
            reload_lock: Mutex::new(()),
            server_boot_id: uuid::Uuid::new_v4().to_string(),
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
                    SidecarEvent::UsageLimits {
                        request_id,
                        providers,
                        error,
                    } => {
                        let sender = pending_usage_limits
                            .lock()
                            .ok()
                            .and_then(|mut pending| pending.remove(&request_id));
                        if let Some(sender) = sender {
                            let result = error
                                .map_or_else(|| Ok(providers.unwrap_or_else(|| json!([]))), Err);
                            let _ = sender.send(result);
                        }
                    }
                    SidecarEvent::Ready => {}
                }
            }
        });
        #[cfg(not(test))]
        {
            let initial_registry = Arc::clone(&registry);
            thread::spawn(move || {
                let deadline = Instant::now() + INITIAL_GATEWAY_WAIT;
                while initial_registry.gateway_credentials().is_none() && Instant::now() < deadline
                {
                    thread::sleep(Duration::from_millis(100));
                }
                if initial_registry
                    .load_state
                    .lock()
                    .is_ok_and(|state| *state != LoadState::NotStarted)
                {
                    return;
                }
                if let Err(error) = initial_registry.reload() {
                    eprintln!("initial plugin load failed: {error}");
                }
            });
        }
        registry
    }

    /// Handles public `plugins` RPC actions.
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
            "usageLimits" => self.usage_limits(payload),
            "logUsageLimitsError" => Self::log_usage_limits_error(payload),
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
        let watchers = self
            .watchers
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?;
        let watcher = resolve_watcher(&watchers, agent_id, plugin_id);
        serde_json::to_value(watcher)
            .map_err(|error| PluginsError::Operation(format!("serialize watcher: {error}")))
    }

    fn register_roots(&self, payload: &Value) -> Result<(), PluginsError> {
        let roots: Vec<String> = payload
            .get("roots")
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default();
        let _reload = self
            .reload_lock
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?;
        if *self.roots.lock().map_err(|_| PluginsError::LockPoisoned)? == roots {
            return Ok(());
        }
        persist_roots(&self.server_dir, &roots);
        (*self.roots.lock().map_err(|_| PluginsError::LockPoisoned)?).clone_from(&roots);
        self.reload_locked()
    }

    /// Adds one project root when absent. Headless session launches call this
    /// concurrently, so root update and catalog reload share one critical
    /// section: one launch reloads while followers wait for that catalog.
    pub fn ensure_root(&self, root: &str) -> Result<(), PluginsError> {
        let _reload = self
            .reload_lock
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?;
        let roots = {
            let mut roots = self.roots.lock().map_err(|_| PluginsError::LockPoisoned)?;
            if roots.iter().any(|existing| existing == root) {
                return Ok(());
            }
            roots.push(root.to_string());
            roots.clone()
        };
        persist_roots(&self.server_dir, &roots);
        self.reload_locked()
    }

    /// Re-sends `load` with the current roots and freshly read gateway
    /// credentials (e.g. after the gateway starts and writes its discovery
    /// file, so dynamic model providers can finally resolve).
    fn reload(&self) -> Result<(), PluginsError> {
        let _reload = self
            .reload_lock
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?;
        self.reload_locked()
    }

    fn reload_locked(&self) -> Result<(), PluginsError> {
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
        let _reload = self
            .reload_lock
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?;
        let state = *self
            .load_state
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?;
        match state {
            LoadState::StartedWithGateway => Ok(()),
            LoadState::StartedWithoutGateway if self.gateway_credentials().is_none() => Ok(()),
            LoadState::NotStarted | LoadState::StartedWithoutGateway => self.reload_locked(),
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
            "stateDir": self.server_dir,
            "serverBootId": self.server_boot_id,
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
        // Serve the bytes the sidecar carried with the catalog. Re-reading the
        // file here made every icon fail once its plugin directory moved or was
        // removed, even though the catalog still advertised the hash.
        if let Some(base64) = entry.base64 {
            return Ok(json!({ "base64": base64, "mime": entry.mime }));
        }
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

    /// Serves the `usageLimits` action from the host's single cache.
    ///
    /// Every client reads the same readings: the host owns the refresh cadence,
    /// so a phone and a desktop asking at the same moment cost each provider one
    /// invocation, not two. Concurrent callers for one scope serialize on that
    /// scope's lock and the loser returns the winner's fresh cache.
    fn usage_limits(&self, payload: &Value) -> Result<Value, PluginsError> {
        self.ensure_catalog_fresh()?;
        let scope = payload
            .get("root")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let plugin_id = payload
            .get("pluginId")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(cached) = self.fresh_usage_limits(&scope, plugin_id.as_deref())? {
            return Ok(json!({ "providers": cached }));
        }
        let scope_lock = self.usage_scope_lock(&scope)?;
        let _guard = scope_lock.lock().map_err(|_| PluginsError::LockPoisoned)?;
        // Re-check under the scope lock: a caller that queued behind a refresh
        // wants that refresh's result, not a second one.
        if let Some(cached) = self.fresh_usage_limits(&scope, plugin_id.as_deref())? {
            return Ok(json!({ "providers": cached }));
        }
        let loaded = self.request_usage_limits(&scope, plugin_id.as_deref())?;
        let merged = self.merge_usage_limits(&scope, loaded)?;
        Ok(json!({ "providers": filter_by_plugin(merged, plugin_id.as_deref()) }))
    }

    /// The cached providers for a scope, when none of them is due a refresh.
    fn fresh_usage_limits(
        &self,
        scope: &str,
        plugin_id: Option<&str>,
    ) -> Result<Option<Vec<Value>>, PluginsError> {
        let cache = self
            .usage_cache
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?;
        let Some(entry) = cache.get(scope) else {
            return Ok(None);
        };
        let now = Instant::now();
        let due =
            entry.states.values().any(|state| state.next_due <= now) || entry.providers.is_empty();
        if due {
            return Ok(None);
        }
        Ok(Some(filter_by_plugin(entry.providers.clone(), plugin_id)))
    }

    /// Per-scope refresh lock, created on first use.
    fn usage_scope_lock(&self, scope: &str) -> Result<Arc<Mutex<()>>, PluginsError> {
        let mut locks = self
            .usage_locks
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?;
        Ok(Arc::clone(
            locks
                .entry(scope.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        ))
    }

    /// Asks the sidecar for one scope's readings and waits for its answer.
    fn request_usage_limits(
        &self,
        scope: &str,
        plugin_id: Option<&str>,
    ) -> Result<Vec<Value>, PluginsError> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::sync_channel(1);
        self.pending_usage_limits
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?
            .insert(request_id.clone(), sender);
        let mut command = json!({
            "type": "usageLimits",
            "requestId": request_id,
        });
        if let Some(plugin_id) = plugin_id {
            command["pluginId"] = Value::String(plugin_id.to_string());
        }
        if !scope.is_empty() {
            command["root"] = Value::String(scope.to_string());
        }
        if let Err(error) = self.sidecar.send(&command) {
            if let Ok(mut pending) = self.pending_usage_limits.lock() {
                pending.remove(&request_id);
            }
            return Err(error);
        }
        let result = receiver
            .recv_timeout(usage_limits_timeout())
            .map_err(|error| {
                if let Ok(mut pending) = self.pending_usage_limits.lock() {
                    pending.remove(&request_id);
                }
                PluginsError::Operation(format!("wait for usage limits: {error}"))
            })?;
        let providers = result.map_err(PluginsError::Operation)?;
        Ok(providers.as_array().cloned().unwrap_or_default())
    }

    /// Folds fresh readings into the scope cache and returns what clients see.
    ///
    /// A provider that just failed keeps its last good reading — with the
    /// original `observedAt`, so the client labels it stale rather than showing
    /// a zero — and earns exponential backoff before the next attempt.
    fn merge_usage_limits(
        &self,
        scope: &str,
        loaded: Vec<Value>,
    ) -> Result<Vec<Value>, PluginsError> {
        let now = Instant::now();
        let observed_at = unix_millis_now();
        let mut cache = self
            .usage_cache
            .lock()
            .map_err(|_| PluginsError::LockPoisoned)?;
        let entry = cache.entry(scope.to_string()).or_default();
        let previous: HashMap<String, Value> = entry
            .providers
            .iter()
            .filter_map(|provider| Some((provider_key(provider)?, provider.clone())))
            .collect();
        let mut merged = Vec::with_capacity(loaded.len());
        for mut provider in loaded {
            let Some(key) = provider_key(&provider) else {
                continue;
            };
            let failed = provider_failed(&provider);
            if failed {
                if let Some(last_good) = previous.get(&key).filter(|prior| !provider_failed(prior))
                {
                    provider = last_good.clone();
                }
            }
            if !failed || provider_failed(&provider) {
                provider["observedAt"] = json!(observed_at);
            }
            let state = entry.states.entry(key).or_default();
            state.failures = if failed { state.failures + 1 } else { 0 };
            state.next_due = now + provider_refresh_delay(&provider, state.failures);
            merged.push(provider);
        }
        // A provider that vanished from the catalog must not linger in the cache.
        let live: Vec<String> = merged.iter().filter_map(provider_key).collect();
        entry.states.retain(|key, _| live.contains(key));
        entry.providers.clone_from(&merged);
        Ok(merged)
    }

    fn log_usage_limits_error(payload: &Value) -> Result<Value, PluginsError> {
        let plugin_id = required_log_field(payload, "pluginId")?;
        let provider_id = required_log_field(payload, "providerId")?;
        let message = required_log_field(payload, "message")?;
        eprintln!("usage limits update failed for {plugin_id}/{provider_id}: {message}");
        Ok(json!({ "ok": true }))
    }
}

/// Cached readings for one scope plus each provider's refresh bookkeeping.
#[derive(Default)]
struct UsageScopeCache {
    providers: Vec<Value>,
    states: HashMap<String, UsageProviderState>,
}

/// How a single provider is faring: consecutive failures and when it is next due.
struct UsageProviderState {
    failures: u32,
    next_due: Instant,
}

impl Default for UsageProviderState {
    fn default() -> Self {
        Self {
            failures: 0,
            next_due: Instant::now(),
        }
    }
}

/// How long the host waits for the sidecar to answer one usage-limits request.
fn usage_limits_timeout() -> Duration {
    Duration::from_millis(millis(CONSTANTS.usage_limits.load_timeout_ms))
}

/// Stable identity of one provider within a scope.
fn provider_key(provider: &Value) -> Option<String> {
    let plugin_id = provider.get("pluginId").and_then(Value::as_str)?;
    let provider_id = provider.get("providerId").and_then(Value::as_str)?;
    Some(format!("{plugin_id}\u{0}{provider_id}"))
}

/// True when a reading is the host's own "the loader threw" placeholder.
///
/// A provider that reports `not-configured` or `authentication-required` is
/// answering correctly — that state is the reading, not a failure — so only
/// `error` earns backoff and last-good substitution.
fn provider_failed(provider: &Value) -> bool {
    let Some(result) = provider.get("result") else {
        return true;
    };
    result.get("status").and_then(Value::as_str) == Some("unavailable")
        && result.get("reason").and_then(Value::as_str) == Some("error")
}

/// The delay before a provider is asked again: its own requested cadence,
/// clamped to the shared floor, then backed off once per consecutive failure.
fn provider_refresh_delay(provider: &Value, failures: u32) -> Duration {
    let policy = &CONSTANTS.usage_limits;
    let floor = millis(policy.min_refresh_interval_ms);
    let requested = provider
        .get("refreshIntervalMs")
        .and_then(Value::as_u64)
        .unwrap_or(floor)
        .max(floor);
    if failures == 0 {
        return Duration::from_millis(requested);
    }
    let backoff = requested.saturating_mul(2u64.saturating_pow(failures.min(16)));
    Duration::from_millis(backoff.min(millis(policy.max_retry_interval_ms)))
}

/// Narrows a scope's providers to one plugin, for a client that asked for one.
fn filter_by_plugin(providers: Vec<Value>, plugin_id: Option<&str>) -> Vec<Value> {
    let Some(plugin_id) = plugin_id else {
        return providers;
    };
    providers
        .into_iter()
        .filter(|provider| provider.get("pluginId").and_then(Value::as_str) == Some(plugin_id))
        .collect()
}

/// A schema-guaranteed-positive millisecond constant as an unsigned duration.
fn millis(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

/// Unix milliseconds, or 0 if the clock is before the epoch.
fn unix_millis_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

fn resolve_watcher(
    watchers: &[WatcherSpec],
    agent_id: &str,
    plugin_id: Option<&str>,
) -> Option<WatcherSpec> {
    let belongs_to_plugin =
        |watcher: &&WatcherSpec| plugin_id.is_none_or(|plugin_id| watcher.plugin_id == plugin_id);
    if let Some(watcher) = watchers
        .iter()
        .filter(belongs_to_plugin)
        .find(|watcher| watcher.agent_id == agent_id)
    {
        return Some(watcher.clone());
    }

    let mut matches = watchers
        .iter()
        .filter(belongs_to_plugin)
        .filter(|watcher| watcher.watcher_agent == agent_id);
    let watcher = matches.next()?.clone();
    matches.next().is_none().then_some(watcher)
}

fn required_log_field(payload: &Value, field: &str) -> Result<String, PluginsError> {
    let value = payload
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PluginsError::InvalidRequest(format!("missing {field}")))?;
    Ok(value
        .chars()
        .take(USAGE_LIMITS_LOG_FIELD_MAX_CHARS)
        .map(|character| {
            if character == '\n' || character == '\r' {
                ' '
            } else {
                character
            }
        })
        .collect())
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
        let mut command = pragma_platform::process::command("bun");
        command
            .arg("packages/plugins-host/src/cli.ts")
            .current_dir(workspace_root());
        command
    } else {
        pragma_platform::process::command(sidecar_executable(SIDECAR_NAME))
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
    use serde_json::json;

    use super::{
        filter_by_plugin, is_lowercase_hex_sha256, provider_failed, provider_refresh_delay,
        resolve_watcher, AssetEntry, PluginsError, PluginsRegistry, SidecarEvent, WatcherSpec,
        PLUGIN_ROOTS_FILE,
    };
    use pragma_constants::CONSTANTS;

    fn watcher(plugin_id: &str, agent_id: &str, watcher_agent: &str) -> WatcherSpec {
        WatcherSpec {
            plugin_id: plugin_id.to_string(),
            agent_id: agent_id.to_string(),
            watcher_agent: watcher_agent.to_string(),
            main_path: "/plugin.mjs".to_string(),
            config: json!({}),
        }
    }

    #[test]
    fn resolves_unique_runtime_agent_watcher_for_existing_sessions() {
        let watchers = vec![watcher(
            "pragma.claude-code",
            "pragma.claude-code",
            "claude-code",
        )];

        let resolved = resolve_watcher(&watchers, "claude-code", None).expect("unique watcher");

        assert_eq!(resolved.agent_id, "pragma.claude-code");
    }

    #[test]
    fn rejects_ambiguous_runtime_agent_watcher() {
        let watchers = vec![
            watcher("pragma.claude-code", "pragma.claude-code", "claude-code"),
            watcher("custom.claude-code", "custom.claude-code", "claude-code"),
        ];

        assert!(resolve_watcher(&watchers, "claude-code", None).is_none());
        assert_eq!(
            resolve_watcher(&watchers, "claude-code", Some("custom.claude-code"))
                .expect("plugin disambiguates")
                .agent_id,
            "custom.claude-code"
        );
    }

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
    fn serves_asset_bytes_without_reading_the_file() {
        let dir =
            std::env::temp_dir().join(format!("pragma-plugins-asset-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create test dir");
        let registry = PluginsRegistry::new(dir);
        let hash = "a".repeat(64);
        registry.assets.lock().expect("assets lock").insert(
            hash.clone(),
            AssetEntry {
                // A path that never existed: an icon must still serve.
                path: "/gone/icon.svg".to_string(),
                mime: "image/svg+xml".to_string(),
                base64: Some("PHN2Zy8+".to_string()),
            },
        );
        let value = registry
            .read_asset(&json!({ "hash": hash }))
            .expect("asset must serve from carried bytes");
        assert_eq!(
            value.get("base64").and_then(|v| v.as_str()),
            Some("PHN2Zy8+")
        );
        assert_eq!(
            value.get("mime").and_then(|v| v.as_str()),
            Some("image/svg+xml")
        );
    }

    #[test]
    fn parses_usage_limits_event() {
        let event: SidecarEvent =
            serde_json::from_str(r#"{"type":"usageLimits","requestId":"req-1","providers":[]}"#)
                .expect("usage limits event must parse");
        assert!(matches!(event, SidecarEvent::UsageLimits { .. }));
    }

    #[test]
    fn usage_limits_error_log_requires_identifying_fields() {
        let result = PluginsRegistry::log_usage_limits_error(&json!({
            "pluginId": "pragma.cursor",
            "providerId": "cursor",
        }));

        assert!(matches!(result, Err(PluginsError::InvalidRequest(_))));
    }

    #[test]
    fn usage_limits_error_log_accepts_complete_event() {
        let result = PluginsRegistry::log_usage_limits_error(&json!({
            "pluginId": "pragma.cursor",
            "providerId": "cursor",
            "message": "not logged in\nretry later",
        }))
        .expect("complete log event");

        assert_eq!(result, json!({ "ok": true }));
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
    fn ensuring_persisted_root_does_not_start_catalog_reload() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(PLUGIN_ROOTS_FILE),
            serde_json::to_vec(&vec!["/project"]).expect("serialize roots"),
        )
        .expect("write roots");
        let registry = PluginsRegistry::new(dir.path().to_path_buf());

        registry.ensure_root("/project").expect("existing root");

        assert_eq!(
            *registry.load_state.lock().expect("load state"),
            super::LoadState::NotStarted,
            "idempotent registration must not reload the plugin sidecar"
        );
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

    fn provider(plugin_id: &str, result: serde_json::Value) -> serde_json::Value {
        json!({
            "pluginId": plugin_id,
            "providerId": "usage",
            "title": "Usage",
            "dashboardUrl": "https://example.com",
            "primaryLimitId": "daily",
            "result": result,
        })
    }

    fn ready(observed_at: u64) -> serde_json::Value {
        json!({
            "status": "ready",
            "observedAt": observed_at,
            "limits": [{ "id": "daily", "title": "Daily", "used": 1, "limit": 10 }],
        })
    }

    fn load_error() -> serde_json::Value {
        json!({ "status": "unavailable", "reason": "error", "message": "boom" })
    }

    fn usage_registry(name: &str) -> std::sync::Arc<PluginsRegistry> {
        let dir = std::env::temp_dir().join(format!("pragma-usage-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create test dir");
        PluginsRegistry::new(dir)
    }

    #[test]
    fn treats_only_a_load_error_as_a_provider_failure() {
        assert!(provider_failed(&provider("p", load_error())));
        assert!(!provider_failed(&provider("p", ready(1))));
        assert!(!provider_failed(&provider(
            "p",
            json!({ "status": "unavailable", "reason": "not-configured", "message": "Sign in" })
        )));
        // A provider that has never produced a reading is not a cached success.
        assert!(provider_failed(
            &json!({ "pluginId": "p", "providerId": "usage" })
        ));
    }

    #[test]
    fn clamps_a_provider_cadence_to_the_shared_floor_and_backs_off_on_failure() {
        let floor = u64::try_from(CONSTANTS.usage_limits.min_refresh_interval_ms).expect("floor");
        let eager = json!({ "refreshIntervalMs": 1 });
        assert_eq!(
            provider_refresh_delay(&eager, 0),
            std::time::Duration::from_millis(floor)
        );
        let patient = json!({ "refreshIntervalMs": floor * 4 });
        assert_eq!(
            provider_refresh_delay(&patient, 0),
            std::time::Duration::from_millis(floor * 4)
        );
        assert_eq!(
            provider_refresh_delay(&eager, 2),
            std::time::Duration::from_millis(floor * 4)
        );
        let ceiling = u64::try_from(CONSTANTS.usage_limits.max_retry_interval_ms).expect("ceiling");
        assert_eq!(
            provider_refresh_delay(&eager, 20),
            std::time::Duration::from_millis(ceiling)
        );
    }

    #[test]
    fn serves_a_cached_reading_until_a_provider_is_due() {
        let registry = usage_registry("fresh");
        registry
            .merge_usage_limits("", vec![provider("a", ready(5))])
            .expect("merge");

        let cached = registry
            .fresh_usage_limits("", None)
            .expect("cache lock")
            .expect("a just-loaded provider is not due again");

        assert_eq!(cached.len(), 1);
        assert!(cached[0].get("observedAt").is_some());
    }

    #[test]
    fn keeps_the_last_good_reading_when_a_provider_starts_failing() {
        let registry = usage_registry("laststood");
        registry
            .merge_usage_limits("", vec![provider("a", ready(5))])
            .expect("first merge");
        let first = registry
            .fresh_usage_limits("", None)
            .expect("cache lock")
            .expect("cached");
        let first_observed = first[0].get("observedAt").cloned().expect("observedAt");

        let merged = registry
            .merge_usage_limits("", vec![provider("a", load_error())])
            .expect("second merge");

        // The card still shows real numbers; the untouched `observedAt` is what
        // lets the client label them stale instead of rendering a zero.
        assert_eq!(
            merged[0].get("result").and_then(|r| r.get("status")),
            Some(&json!("ready"))
        );
        assert_eq!(merged[0].get("observedAt"), Some(&first_observed));
    }

    #[test]
    fn drops_a_provider_that_left_the_catalog() {
        let registry = usage_registry("dropped");
        registry
            .merge_usage_limits("", vec![provider("a", ready(1)), provider("b", ready(1))])
            .expect("first merge");

        let merged = registry
            .merge_usage_limits("", vec![provider("a", ready(2))])
            .expect("second merge");

        assert_eq!(merged.len(), 1);
        let cache = registry.usage_cache.lock().expect("cache lock");
        assert_eq!(cache.get("").expect("scope").states.len(), 1);
    }

    #[test]
    fn scopes_the_cache_by_project_root() {
        let registry = usage_registry("scoped");
        registry
            .merge_usage_limits("/repo", vec![provider("a", ready(1))])
            .expect("merge");

        assert!(registry
            .fresh_usage_limits("/other", None)
            .expect("cache lock")
            .is_none());
    }

    #[test]
    fn narrows_a_response_to_the_requested_plugin() {
        let providers = vec![provider("a", ready(1)), provider("b", ready(1))];

        let filtered = filter_by_plugin(providers.clone(), Some("b"));

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].get("pluginId"), Some(&json!("b")));
        assert_eq!(filter_by_plugin(providers, None).len(), 2);
    }
}
