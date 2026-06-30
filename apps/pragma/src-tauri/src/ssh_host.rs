//! Remote project connection over SSH.
//!
//! `connect_remote_project` is the entry point behind the Add-project "Remote"
//! tab. It validates SSH credentials and a typed remote path, confirms the path
//! is a git repo, ensures a protocol-compatible `pragma-server` is running on
//! the host, opens an SSH streamlocal bridge for ongoing RPC/PTY, registers the
//! host in [`Hosts`], records the project → host route, and inserts the project
//! locally. Thereafter every filesystem/git/terminal operation for that project
//! routes over the bridge to the remote server (see `hosts.rs`).

use std::path::Path;
use std::sync::Mutex;

use pragma_client::router::ProjectRoute;
use pragma_client::{
    ssh_exec, start_ssh_bridge, RemoteAuth, SshBridgeConfig, SshConnectConfig, SshExecResult,
};
use pragma_constants::{Project, CONSTANTS};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::agent_events;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::hosts::{Hosts, RemoteHost, LOCAL_HOST};
use crate::pty::PtyClient;

/// Remote channel the host server runs under. Single source of truth so the
/// forwarded socket path is deterministic.
const REMOTE_CHANNEL: &str = pragma_protocol::PROD_CHANNEL;
static REMOTE_RECONNECT_LOCK: Mutex<()> = Mutex::new(());

/// How the user chose to authenticate. SSH agent is the default; key file and
/// password are the alternatives surfaced under "More options".
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoteAuthChoice {
    /// Keys from the running SSH agent.
    Agent,
    /// A private key file with optional passphrase.
    Key {
        path: String,
        passphrase: Option<String>,
    },
    /// A password.
    Password { password: String },
}

/// Credentials + target the Remote tab collects.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectRequest {
    /// SSH hostname or IP.
    pub host: String,
    /// SSH port (typically 22).
    pub port: u16,
    /// SSH username.
    pub user: String,
    /// Authentication method.
    pub auth: RemoteAuthChoice,
    /// Project path on the remote host, e.g. `~/projects/remote-project`.
    pub path: String,
}

/// Non-secret connection metadata persisted in the client-local router DB.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteRoutePreferences {
    host: String,
    port: u16,
    user: String,
    auth_method: RemoteRouteAuthMethod,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum RemoteRouteAuthMethod {
    Agent,
    Key,
    Password,
}

/// Connects to a remote host and registers the project found at `path`.
///
/// The blocking SSH work (probe, bridge, version check) runs on the blocking
/// pool with owned data; the quick state mutations (register host, write route,
/// insert project) run inline since `Db` is not `Send` across the pool.
#[tauri::command]
pub async fn connect_remote_project(
    app: AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    request: RemoteConnectRequest,
) -> AppResult<Project> {
    let config = connect_config(&request);
    let id = host_id(&request);
    let path = request.path.clone();

    // 1. Probe the remote: resolve the absolute path, confirm a git repo, read
    //    the branch and home directory.
    let probe = {
        let config = config.clone();
        tauri::async_runtime::spawn_blocking(move || probe_remote(&config, &path))
            .await
            .map_err(|error| AppError::Daemon(format!("remote probe task failed: {error}")))??
    };

    // 2. Open the streamlocal bridge (its bootstrap ensures the server is up)
    //    and version-check the remote server before routing to it.
    let client = {
        let id = id.clone();
        let config = config.clone();
        let home = probe.home.clone();
        tauri::async_runtime::spawn_blocking(move || connect_client(&id, &config, &home))
            .await
            .map_err(|error| AppError::Daemon(format!("ssh bridge task failed: {error}")))??
    };

    // 3. Register the live host, persist the route, and insert the project.
    hosts.register_remote(
        id.clone(),
        RemoteHost {
            client: client.clone(),
            label: format!("{}@{}", request.user, request.host),
        },
    )?;
    agent_events::start_for(app, client);
    hosts
        .router()
        .set_project_route(&ProjectRoute {
            project_key: probe.abs_path.clone(),
            host_id: id,
            preferences: serde_json::to_value(route_preferences(&request))?,
        })
        .map_err(|error| AppError::Daemon(format!("failed to record remote route: {error}")))?;
    let name = project_name(&probe.abs_path);
    db.insert_project_with_main_worktree(name, probe.abs_path, probe.branch)
}

/// Attempts to reconnect persisted agent-authenticated remote hosts in the
/// background. Passwords and key passphrases are never persisted, so those routes
/// intentionally remain disconnected until the user reconnects them.
pub fn reconnect_remote_hosts(app: AppHandle) {
    std::thread::spawn(move || {
        let hosts = app.state::<Hosts>();
        let routes = match hosts.router().project_routes() {
            Ok(routes) => routes,
            Err(error) => {
                log::warn!("failed to load remote host routes: {error}");
                return;
            }
        };
        for route in routes {
            if route.host_id == LOCAL_HOST {
                continue;
            }
            let preferences =
                match serde_json::from_value::<RemoteRoutePreferences>(route.preferences) {
                    Ok(preferences) => preferences,
                    Err(error) => {
                        log::warn!(
                            "skipping remote host '{}': invalid route preferences: {error}",
                            route.host_id
                        );
                        continue;
                    }
                };
            if preferences.auth_method != RemoteRouteAuthMethod::Agent {
                log::info!(
                    "remote host '{}' uses non-agent auth and will reconnect when credentials are supplied",
                    route.host_id
                );
                continue;
            }
            let config = SshConnectConfig {
                host: preferences.host.clone(),
                port: preferences.port,
                user: preferences.user.clone(),
                auth: RemoteAuth::Agent,
            };
            let reconnect_result = REMOTE_RECONNECT_LOCK
                .lock()
                .map_err(|_| AppError::LockPoisoned)
                .and_then(|_guard| reconnect_remote_host(&route.host_id, &config));
            match reconnect_result {
                Ok(client) => {
                    let label = format!("{}@{}", preferences.user, preferences.host);
                    if let Err(error) = hosts.register_remote(
                        route.host_id.clone(),
                        RemoteHost {
                            client: client.clone(),
                            label,
                        },
                    ) {
                        log::warn!(
                            "failed to register remote host '{}': {error}",
                            route.host_id
                        );
                        continue;
                    }
                    agent_events::start_for(app.clone(), client);
                }
                Err(error) => {
                    log::warn!(
                        "failed to reconnect remote host '{}': {error}",
                        route.host_id
                    );
                }
            }
        }
    });
}

/// Resolves a host client, reconnecting a persisted agent-auth remote on demand.
/// This avoids startup races where a terminal spawns before the background remote
/// reconnect thread has registered the host in memory.
pub async fn client_for_host(app: AppHandle, hosts: &Hosts, host_id: &str) -> AppResult<PtyClient> {
    if let Ok(client) = hosts.client_for_host(host_id) {
        return Ok(client);
    }
    if host_id == LOCAL_HOST {
        return hosts.client_for_host(host_id);
    }
    let preferences = remote_preferences_for_host(hosts, host_id)?;
    if preferences.auth_method != RemoteRouteAuthMethod::Agent {
        return hosts.client_for_host(host_id);
    }
    let config = SshConnectConfig {
        host: preferences.host.clone(),
        port: preferences.port,
        user: preferences.user.clone(),
        auth: RemoteAuth::Agent,
    };
    let reconnect_host_id = host_id.to_string();
    let client = tauri::async_runtime::spawn_blocking(move || {
        let _guard = REMOTE_RECONNECT_LOCK
            .lock()
            .map_err(|_| AppError::LockPoisoned)?;
        reconnect_remote_host(&reconnect_host_id, &config)
    })
    .await
    .map_err(|error| AppError::Daemon(format!("remote reconnect task failed: {error}")))??;

    hosts.register_remote(
        host_id.to_string(),
        RemoteHost {
            client: client.clone(),
            label: format!("{}@{}", preferences.user, preferences.host),
        },
    )?;
    agent_events::start_for(app, client.clone());
    Ok(client)
}

/// Resolves the client for a worktree's host, reconnecting a persisted remote
/// on demand (see [`client_for_host`]). This is the helper worktree-scoped
/// commands (filesystem, file watch) should use instead of `Hosts::for_worktree`,
/// so they don't race the background remote-reconnect thread on first load.
pub async fn client_for_worktree(
    app: AppHandle,
    db: &Db,
    hosts: &Hosts,
    worktree_id: &str,
) -> AppResult<PtyClient> {
    let host_id = hosts.host_id_for_worktree(db, worktree_id)?;
    client_for_host(app, hosts, &host_id).await
}

/// Resolves the client for a previously-spawned PTY session, keyed by session
/// id (== tab id). The session→host binding only lives in memory
/// (`Hosts::bind_session`), so it's lost on every app restart; `for_session`
/// alone would then silently default a remote session to `local`, routing the
/// request at the wrong daemon entirely. This falls back to the session's
/// owning tab's worktree route — the same persisted lookup `pty_spawn` uses —
/// reconnecting a remote host on demand, then re-binds the session so later
/// ops on it (write/resize/kill) hit the cached host without another lookup.
pub async fn client_for_session(
    app: AppHandle,
    db: &Db,
    hosts: &Hosts,
    session_id: &str,
) -> AppResult<PtyClient> {
    if let Some(host_id) = hosts.session_host_id(session_id) {
        return client_for_host(app, hosts, &host_id).await;
    }
    let tab = db.tab(session_id)?;
    let host_id = hosts.host_id_for_worktree(db, &tab.worktree_id)?;
    let client = client_for_host(app, hosts, &host_id).await?;
    hosts.bind_session(session_id.to_string(), host_id)?;
    Ok(client)
}

fn remote_preferences_for_host(hosts: &Hosts, host_id: &str) -> AppResult<RemoteRoutePreferences> {
    let routes = hosts
        .router()
        .project_routes()
        .map_err(|error| AppError::Daemon(format!("failed to load remote routes: {error}")))?;
    routes
        .into_iter()
        .find(|route| route.host_id == host_id)
        .ok_or_else(|| AppError::Daemon(format!("remote host '{host_id}' is not connected")))
        .and_then(|route| {
            Ok(serde_json::from_value::<RemoteRoutePreferences>(
                route.preferences,
            )?)
        })
}

/// Derives a project display name from the remote absolute path.
fn project_name(abs_path: &str) -> String {
    abs_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or("project")
        .to_string()
}

/// Builds a one-shot SSH connection config from the request.
fn connect_config(request: &RemoteConnectRequest) -> SshConnectConfig {
    let auth = match &request.auth {
        RemoteAuthChoice::Agent => RemoteAuth::Agent,
        RemoteAuthChoice::Key { path, passphrase } => RemoteAuth::Key {
            path: expand_local_tilde(path),
            passphrase: passphrase.clone(),
        },
        RemoteAuthChoice::Password { password } => RemoteAuth::Password(password.clone()),
    };
    SshConnectConfig {
        host: request.host.clone(),
        port: request.port,
        user: request.user.clone(),
        auth,
    }
}

fn route_preferences(request: &RemoteConnectRequest) -> RemoteRoutePreferences {
    RemoteRoutePreferences {
        host: request.host.clone(),
        port: request.port,
        user: request.user.clone(),
        auth_method: match &request.auth {
            RemoteAuthChoice::Agent => RemoteRouteAuthMethod::Agent,
            RemoteAuthChoice::Key { .. } => RemoteRouteAuthMethod::Key,
            RemoteAuthChoice::Password { .. } => RemoteRouteAuthMethod::Password,
        },
    }
}

fn reconnect_remote_host(host_id: &str, config: &SshConnectConfig) -> AppResult<PtyClient> {
    let home = probe_remote_home(config)?;
    connect_client(host_id, config, &home)
}

fn connect_client(host_id: &str, config: &SshConnectConfig, home: &str) -> AppResult<PtyClient> {
    let local_sock = local_socket_path(host_id);
    let bridge_config = SshBridgeConfig {
        host: config.host.clone(),
        port: config.port,
        user: config.user.clone(),
        auth: config.auth.clone(),
        remote_socket_path: remote_socket_path(home),
        local_socket_path: local_sock.clone(),
        bootstrap_command: bootstrap_command(),
    };
    start_ssh_bridge(bridge_config)
        .map_err(|error| AppError::Daemon(format!("ssh bridge: {error}")))?;
    let client = PtyClient::new_socket(local_sock);
    let version = client
        .server_protocol_version()
        .map_err(|error| AppError::Daemon(format!("remote server unreachable: {error}")))?;
    let expected = CONSTANTS.daemon.protocol_version.get();
    if version != expected {
        return Err(AppError::Daemon(format!(
            "remote pragma-server speaks protocol v{version}, but this client requires v{expected}. \
             Update pragma-server on the remote host to a matching version and reconnect."
        )));
    }
    Ok(client)
}

fn probe_remote_home(config: &SshConnectConfig) -> AppResult<String> {
    let result = run_exec(config, "printf 'HOME=%s\\n' \"$HOME\"")?;
    let home = line_value(&result.stdout, "HOME=").unwrap_or_default();
    if home.is_empty() {
        return Err(AppError::Daemon(
            "could not resolve the remote home directory".to_string(),
        ));
    }
    Ok(home)
}

/// Expands a leading `~` in a local path (for key files) using `$HOME`.
fn expand_local_tilde(path: &str) -> std::path::PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return Path::new(&home).join(rest);
        }
    }
    std::path::PathBuf::from(path)
}

/// Rewrites a leading `~` to `$HOME` so it expands inside a double-quoted remote
/// shell word. Rejects characters that would break out of the quoting.
fn remote_shell_path(input: &str) -> AppResult<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("remote path is empty".to_string()));
    }
    if trimmed.contains(['"', '`', '\\', '\n', '(']) {
        return Err(AppError::InvalidInput(
            "remote path contains unsupported characters".to_string(),
        ));
    }
    Ok(if trimmed == "~" {
        "$HOME".to_string()
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        format!("$HOME/{rest}")
    } else {
        trimmed.to_string()
    })
}

/// One probe of the remote: resolves the absolute path, confirms it's a git
/// repo, reads the branch, and reports `$HOME` (for the server socket path).
struct RemoteProbe {
    abs_path: String,
    branch: String,
    home: String,
}

fn probe_remote(config: &SshConnectConfig, path: &str) -> AppResult<RemoteProbe> {
    let shell_path = remote_shell_path(path)?;
    // One round trip resolves everything we need. `pwd -P` canonicalizes; the
    // git checks are best-effort and parsed from labelled lines.
    let command = format!(
        "abs=$(cd \"{shell_path}\" 2>/dev/null && pwd -P); \
         if [ -z \"$abs\" ]; then echo 'ABS='; else \
         echo \"ABS=$abs\"; \
         echo \"GIT=$(git -C \"$abs\" rev-parse --is-inside-work-tree 2>/dev/null)\"; \
         echo \"BRANCH=$(git -C \"$abs\" branch --show-current 2>/dev/null)\"; fi; \
         echo \"HOME=$HOME\""
    );
    let result = run_exec(config, &command)?;
    if result.exit_code != 0 {
        return Err(AppError::Daemon(format!(
            "remote probe failed (exit {}): {}",
            result.exit_code,
            result.stderr.trim()
        )));
    }
    let abs_path = line_value(&result.stdout, "ABS=").unwrap_or_default();
    if abs_path.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "remote path '{path}' was not found on the host"
        )));
    }
    if line_value(&result.stdout, "GIT=").as_deref() != Some("true") {
        return Err(AppError::InvalidInput(format!(
            "remote path '{abs_path}' is not a git repository"
        )));
    }
    let branch = line_value(&result.stdout, "BRANCH=").unwrap_or_default();
    let home = line_value(&result.stdout, "HOME=").unwrap_or_default();
    if home.is_empty() {
        return Err(AppError::Daemon(
            "could not resolve the remote home directory".to_string(),
        ));
    }
    Ok(RemoteProbe {
        abs_path,
        branch: if branch.is_empty() {
            "HEAD".to_string()
        } else {
            branch
        },
        home,
    })
}

/// Runs a remote command, mapping transport failures to `AppError`.
fn run_exec(config: &SshConnectConfig, command: &str) -> AppResult<SshExecResult> {
    ssh_exec(config, command).map_err(|error| AppError::Daemon(format!("ssh: {error}")))
}

/// Extracts the value of the first `prefix`-tagged line in `text`.
fn line_value(text: &str, prefix: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix(prefix))
        .map(|value| value.trim().to_string())
}

/// Stable host id for a connection, used as the router `host_id` and the remote
/// map key.
fn host_id(request: &RemoteConnectRequest) -> String {
    format!("ssh://{}@{}:{}", request.user, request.host, request.port)
}

/// Local Unix socket path the bridge listens on for this host.
fn local_socket_path(host_id: &str) -> std::path::PathBuf {
    let sanitized: String = host_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    std::env::temp_dir().join(format!("pragma-remote-{sanitized}.sock"))
}

/// Bootstrap command that ensures a protocol-pinned `pragma-server` is running
/// on the remote with a deterministic socket path. Forces `PRAGMA_APP_DATA_DIR`
/// and unsets `XDG_RUNTIME_DIR` so the socket lands at
/// `$HOME/.pragma/<channel>/daemon.sock` regardless of the login environment.
fn bootstrap_command() -> String {
    format!(
        "PATH=\"$HOME/.cargo/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH\" \
         env -u XDG_RUNTIME_DIR PRAGMA_APP_DATA_DIR=\"$HOME/.pragma\" \
         PRAGMA_SERVER_CHANNEL={REMOTE_CHANNEL} PRAGMA_DAEMON_CHANNEL={REMOTE_CHANNEL} \
         pragma-server --detach"
    )
}

/// The remote `daemon.sock` path the bridge forwards.
fn remote_socket_path(home: &str) -> String {
    format!("{home}/.pragma/{REMOTE_CHANNEL}/daemon.sock")
}

#[cfg(test)]
mod tests {
    use super::{line_value, remote_shell_path};

    #[test]
    fn rewrites_tilde_for_remote_shell() {
        assert_eq!(remote_shell_path("~").unwrap(), "$HOME");
        assert_eq!(
            remote_shell_path("~/projects/x").unwrap(),
            "$HOME/projects/x"
        );
        assert_eq!(remote_shell_path("/abs/path").unwrap(), "/abs/path");
    }

    #[test]
    fn rejects_quote_injection() {
        assert!(remote_shell_path("~/a\"; rm -rf /").is_err());
        assert!(remote_shell_path("").is_err());
    }

    #[test]
    fn rejects_command_substitution() {
        assert!(remote_shell_path("~/x/$(touch /tmp/pwned)").is_err());
    }

    #[test]
    fn parses_labelled_lines() {
        let out = "ABS=/home/u/p\nGIT=true\nBRANCH=main\nHOME=/home/u\n";
        assert_eq!(line_value(out, "ABS=").as_deref(), Some("/home/u/p"));
        assert_eq!(line_value(out, "BRANCH=").as_deref(), Some("main"));
        assert_eq!(line_value(out, "MISSING=").as_deref(), None);
    }
}
