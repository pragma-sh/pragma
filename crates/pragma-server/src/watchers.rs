//! Headless watcher spawn for controller-free agent launches.
//!
//! The desktop frontend normally starts a detached `pragma-watch` sidecar per
//! agent session (`startWatcherForAgentSession`) that subscribes to gateway
//! agent events and delivers chat interjections, question answers, approval
//! verdicts, and interrupts into the agent's TUI. When the server launches an
//! agent headlessly (no desktop controller) it must start that watcher itself,
//! or a paired phone's replies never reach the agent.
//!
//! V1 covers the built-in agents (Claude Code, opencode, Cursor), which all
//! share the `@pragma/opencode-plugin` watcher module. Config-plugin watchers
//! still require the desktop to launch the session.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

use pragma_constants::CONSTANTS;
use serde_json::Value;

/// The plugin id the desktop passes for built-in watcher instances; carried
/// only for logging/dedup inside the watcher process.
const BUILTIN_WATCHER_PLUGIN_ID: &str = "pragma.builtin-agents";

/// Catalog plugin ids whose agents are served by the shared built-in watcher
/// module. Kept in sync with `BUILTIN_PLUGINS` in `packages/plugins-host`.
const BUILTIN_AGENT_PLUGIN_IDS: [&str; 3] =
    ["pragma.claude-code", "pragma.opencode", "pragma.cursor"];

/// Starts the built-in watcher for a headless agent launch. Best-effort: a
/// missing gateway, watcher bundle, or non-built-in agent logs and skips —
/// the session still runs, phone replies just cannot reach it.
pub fn start_for_headless_launch(
    server_dir: &Path,
    agent_plugin_id: Option<&str>,
    agent_id: &str,
    tab_id: &str,
    worktree_id: &str,
) {
    if !agent_plugin_id.is_some_and(|id| BUILTIN_AGENT_PLUGIN_IDS.contains(&id)) {
        eprintln!(
            "headless launch: no built-in watcher for agent {agent_id} (plugin {agent_plugin_id:?}); phone replies will not reach it"
        );
        return;
    }
    let Some((gateway_url, gateway_token)) = gateway_credentials(server_dir) else {
        eprintln!("headless launch: gateway is not running; skipping watcher for {agent_id}");
        return;
    };
    let Some(watcher_main) = builtin_watcher_main() else {
        eprintln!("headless launch: no watcher bundle found; skipping watcher for {agent_id}");
        return;
    };
    let mut command = watcher_command();
    command
        .args(["--pluginId", BUILTIN_WATCHER_PLUGIN_ID])
        .arg("--pluginMain")
        .arg(&watcher_main)
        .args(["--agentId", agent_id])
        .args(["--watcherAgent", agent_id])
        .args(["--config", "{}"])
        .args(["--sessionId", tab_id])
        .args(["--tabId", tab_id])
        .args(["--worktreeId", worktree_id])
        .args(["--gatewayUrl", &gateway_url])
        .args(["--gatewayToken", &gateway_token])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    match command.spawn() {
        Ok(mut child) => {
            thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(error) => eprintln!("headless launch: failed to spawn watcher for {agent_id}: {error}"),
    }
}

/// Reads the gateway `(url, token)` from the discovery file beside the socket.
/// Mirrors the plugins host's credential read.
pub fn gateway_credentials(server_dir: &Path) -> Option<(String, String)> {
    let path = server_dir.join(CONSTANTS.gateway.discovery_file.as_str());
    let contents = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&contents).ok()?;
    let port = value.get("port").and_then(Value::as_u64)?;
    let token = value.get("token").and_then(Value::as_str)?;
    if port == 0 || token.is_empty() {
        return None;
    }
    Some((format!("http://127.0.0.1:{port}"), token.to_string()))
}

/// The `pragma-watch` invocation: dev runs the workspace CLI through bun,
/// release runs the bundled sidecar beside this server binary.
fn watcher_command() -> Command {
    if cfg!(debug_assertions) {
        let mut command = Command::new("bun");
        command
            .arg(workspace_root().join("packages/watcher/src/cli.ts"))
            .current_dir(workspace_root());
        command
    } else {
        Command::new(sidecar_executable("pragma-watch"))
    }
}

/// Resolves the built-in watcher module: dev imports the workspace TypeScript
/// source; release resolves the staged bundle inside the app resource
/// directory the desktop forwarded via `PRAGMA_RESOURCE_DIR` when it spawned
/// this server (mirrors `resolve_builtin_watcher_main` in the desktop's
/// `plugins.rs`).
fn builtin_watcher_main() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return Some(workspace_root().join("packages/opencode-plugin/src/pragma-watcher.ts"));
    }
    let rel = Path::new("plugins/opencode/pragma-watcher.mjs");
    std::env::var_os("PRAGMA_RESOURCE_DIR")
        .map(PathBuf::from)
        .into_iter()
        .flat_map(|dir| [dir.join("resources").join(rel), dir.join(rel)])
        .find(|candidate| candidate.exists())
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
    use super::gateway_credentials;

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
        assert_eq!(
            gateway_credentials(dir.path()),
            Some(("http://127.0.0.1:4242".to_string(), "abc".to_string()))
        );
    }
}
