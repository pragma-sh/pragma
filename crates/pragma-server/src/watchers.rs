//! Headless watcher spawn for controller-free agent launches.
//!
//! The desktop frontend normally starts a detached `pragma-watch` sidecar per
//! agent session (`startWatcherForAgentSession`) that subscribes to gateway
//! agent events and delivers chat interjections, question answers, approval
//! verdicts, and interrupts into the agent's TUI. When the server launches an
//! agent headlessly (no desktop controller) it must start that watcher itself,
//! or a paired phone's replies never reach the agent.
//!
//! Watcher resolution is catalog-driven: the plugin catalog sidecar reports a
//! watcher spec (bundle path + config) for every plugin that declares one, so
//! any installed agent plugin — bundled with the app or user-configured —
//! gets its watcher headlessly with no per-plugin code here.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

use pragma_constants::CONSTANTS;
use serde_json::Value;

use crate::plugins_host::{PluginsRegistry, WatcherSpec};

/// Starts the plugin-declared watcher for a headless agent launch.
/// Best-effort: a missing gateway, watcher declaration, or bundle logs and
/// skips — the session still runs, phone replies just cannot reach it.
pub fn start_for_headless_launch(
    plugins: &PluginsRegistry,
    server_dir: &Path,
    agent_plugin_id: Option<&str>,
    agent_id: &str,
    tab_id: &str,
    worktree_id: &str,
) {
    let payload = serde_json::json!({
        "action": "watcher",
        "agentId": agent_id,
        "pluginId": agent_plugin_id,
    });
    let watcher: Option<WatcherSpec> = plugins
        .handle_internal_rpc(&payload)
        .ok()
        .and_then(|value| serde_json::from_value(value).ok());
    let Some(watcher) = watcher else {
        eprintln!(
            "headless launch: no plugin watcher declared for agent {agent_id} (plugin {agent_plugin_id:?}); phone replies will not reach it"
        );
        return;
    };
    let Some((gateway_url, gateway_token)) = gateway_credentials(server_dir) else {
        eprintln!("headless launch: gateway is not running; skipping watcher for {agent_id}");
        return;
    };
    if !Path::new(&watcher.main_path).is_file() {
        eprintln!(
            "headless launch: watcher bundle missing at {}; skipping watcher for {agent_id}",
            watcher.main_path
        );
        return;
    }
    let mut command = watcher_command();
    command
        .args(["--pluginId", &watcher.plugin_id])
        .args(["--pluginMain", &watcher.main_path])
        .args(["--agentId", &watcher.watcher_agent])
        .args(["--watcherAgent", &watcher.watcher_agent])
        .args(["--config", &watcher.config.to_string()])
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
