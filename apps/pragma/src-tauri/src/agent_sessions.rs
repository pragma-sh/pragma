//! Desktop adapters for the host's `tabs` RPC agent-session ops.
//!
//! Every agent launch asks the worktree's owning host to prepare its invocation
//! (`prepareAgentLaunch`) before the command is written to the shell, so the host
//! can wrap a supported agent in `pragma-cli agent run --run-id …`, track the
//! child's exit for crash / native-update resume, and render the literal command
//! line from the live session's actual shell. After a crash or an update quit,
//! mounting a tab whose PTY is gone asks the same host to restore the session
//! (`restoreAgentSession`). The host owns eligibility, so an unsupported agent
//! or an ineligible record simply comes back unchanged / `false`.
//!
//! The desktop forwards what the host returns — argv, run id, command line —
//! and never re-resolves the shell or re-quotes the argv: only the host that
//! owns the session can quote for the shell that will parse the typed line,
//! which matters for a Windows PowerShell/cmd tab and for a remote host whose
//! platform is not the desktop's.

use pragma_constants::{AgentLaunchSelection, ProtocolRpcMethod};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::hosts::Hosts;
use crate::pty::PtyClient;
use crate::ssh_host;
use crate::workspace_mirror;

/// Result of `prepareAgentLaunch`: the argv to run — wrapped in
/// `pragma-cli agent run --run-id …` for a supported agent, unchanged for an
/// unsupported one — plus the tracked run id and the command line the host
/// computed for the session's actual shell.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAgentLaunch {
    pub command: Vec<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    /// The literal command line to type, computed by the host for a tracked
    /// launch. `None` for an unsupported agent, whose caller keeps its legacy
    /// join; a tracked launch with no line is a host error the caller surfaces
    /// rather than re-joining the argv itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_line: Option<String>,
}

/// The `prepareAgentLaunch` payload for the host's `tabs` RPC.
pub(crate) fn prepare_agent_launch_payload(
    tab_id: &str,
    worktree_id: &str,
    agent_id: &str,
    command: &[String],
    selection: Option<&AgentLaunchSelection>,
) -> serde_json::Value {
    json!({
        "action": "prepareAgentLaunch",
        "tabId": tab_id,
        "worktreeId": worktree_id,
        "agentId": agent_id,
        "command": command,
        "selection": selection,
    })
}

/// The `restoreAgentSession` payload for the host's `tabs` RPC.
pub(crate) fn restore_agent_session_payload(tab_id: &str, worktree_id: &str) -> serde_json::Value {
    json!({
        "action": "restoreAgentSession",
        "tabId": tab_id,
        "worktreeId": worktree_id,
    })
}

/// Registers every project root with the host's plugin catalog.
///
/// `registerRoots` replaces the root set, so the full list is sent in the same
/// order the frontend registers it; an unchanged list is a server-side no-op.
/// This runs before an agent-session op resolves an agent so a brand-new
/// project's catalog is loaded rather than failing the launch as unknown.
fn register_plugin_roots(client: &PtyClient, roots: &[String]) -> AppResult<()> {
    client.rpc(
        ProtocolRpcMethod::Plugins,
        json!({ "action": "registerRoots", "roots": roots }),
    )?;
    Ok(())
}

/// Prepares a tracked agent invocation on the worktree's owning host, before the
/// desktop writes the command to the shell. A failed RPC is an error, never a
/// silent fallback to the untracked command: for a supported agent that fallback
/// would start a fresh conversation the resume contract exists to prevent.
///
/// The launch's PTY must already exist on the host (the foreground path prepares
/// after its terminal connected, the background path spawns before preparing):
/// the host renders the command line from the live session's shell program, so
/// preparing before the session exists would leave it without one.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Launch preparation carries routing, identity, argv, and choices.
pub async fn prepare_agent_launch(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    tab_id: String,
    agent_id: String,
    command: Vec<String>,
    selection: Option<AgentLaunchSelection>,
) -> AppResult<PreparedAgentLaunch> {
    // Resolve (and reconnect) the owning host first, so the snapshot barrier
    // below reaches the host this launch will run on.
    let client = ssh_host::client_for_worktree(app.clone(), &db, &hosts, &worktree_id).await?;
    let host_id = hosts.host_id_for_worktree(&db, &worktree_id)?;
    let project_roots: Vec<String> = db
        .list_projects()?
        .into_iter()
        .map(|project| project.path)
        .collect();
    let barrier_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // The host resolves the worktree and the mirrored tab (its shell, for
        // the durable record) from the workspace snapshot; the debounced
        // publisher may not have delivered a worktree or tab created moments
        // ago, so publish this host's snapshot and wait for its acknowledgement.
        workspace_mirror::publish_snapshot_to(&barrier_app, &host_id)?;
        register_plugin_roots(&client, &project_roots)?;
        let value = client.rpc(
            ProtocolRpcMethod::Tabs,
            prepare_agent_launch_payload(
                &tab_id,
                &worktree_id,
                &agent_id,
                &command,
                selection.as_ref(),
            ),
        )?;
        serde_json::from_value(value).map_err(|error| AppError::Daemon(error.to_string()))
    })
    .await
    .map_err(|error| AppError::Daemon(format!("agent launch preparation task failed: {error}")))?
}

/// Asks the worktree's owning host to restore an interrupted agent session for
/// `tab_id`. `false` means there is no eligible record (a plain tab, or nothing
/// to resume). A host that still has a live PTY keeps it and reports success
/// instead of spawning a duplicate.
#[tauri::command]
pub async fn restore_agent_session(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    tab_id: String,
) -> AppResult<bool> {
    let client = ssh_host::client_for_worktree(app, &db, &hosts, &worktree_id).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let value = client.rpc(
            ProtocolRpcMethod::Tabs,
            restore_agent_session_payload(&tab_id, &worktree_id),
        )?;
        Ok(value
            .get("restored")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false))
    })
    .await
    .map_err(|error| AppError::Daemon(format!("agent session restore task failed: {error}")))?
}

/// Reads recovery progress from every connected host without initiating a restore.
#[tauri::command]
pub async fn session_restore_status(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
) -> AppResult<Vec<pragma_core::tabs::SessionRestoreSnapshot>> {
    let clients = hosts.all_clients()?;
    let tabs = db.list_all_tabs()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut snapshots = Vec::new();
        for client in clients {
            let result = client.rpc(
                ProtocolRpcMethod::Tabs,
                json!({ "action": "sessionRestoreStatus" }),
            );
            match result.and_then(|value| {
                serde_json::from_value::<pragma_core::tabs::SessionRestoreSnapshot>(value)
                    .map_err(|error| AppError::Daemon(error.to_string()))
            }) {
                Ok(mut snapshot) => {
                    for session in &mut snapshot.sessions {
                        if let Some(tab) = tabs.iter().find(|tab| tab.id == session.tab_id) {
                            if let Some(title) = &tab.title {
                                session.title.clone_from(title);
                            }
                        }
                    }
                    snapshots.push(snapshot);
                }
                // An offline/older remote must not hide another host's recovery.
                Err(error) => log::debug!("session recovery progress unavailable: {error}"),
            }
        }
        Ok(snapshots)
    })
    .await
    .map_err(|error| AppError::Daemon(format!("session recovery progress task failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::{
        prepare_agent_launch_payload, restore_agent_session_payload, AgentLaunchSelection,
        PreparedAgentLaunch,
    };

    #[test]
    fn prepare_payload_is_action_tagged_with_camel_case_fields() {
        let payload = prepare_agent_launch_payload(
            "tab-1",
            "wt-1",
            "plugin.agent",
            &["opencode".to_string(), "--model".to_string()],
            None,
        );
        assert_eq!(payload["action"], "prepareAgentLaunch");
        assert!(
            payload.get("op").is_none(),
            "the tabs RPC is tagged `action`; no second tag is sent"
        );
        assert_eq!(payload["tabId"], "tab-1");
        assert_eq!(payload["worktreeId"], "wt-1");
        assert_eq!(payload["agentId"], "plugin.agent");
        assert_eq!(
            payload["command"],
            serde_json::json!(["opencode", "--model"])
        );
        assert!(payload["selection"].is_null());
    }

    #[test]
    fn restore_payload_is_action_tagged_with_camel_case_fields() {
        let payload = restore_agent_session_payload("tab-1", "wt-1");
        assert_eq!(payload["action"], "restoreAgentSession");
        assert!(payload.get("op").is_none());
        assert_eq!(payload["tabId"], "tab-1");
        assert_eq!(payload["worktreeId"], "wt-1");
    }

    #[test]
    fn selection_serializes_camel_case_and_parses_back_on_the_host() {
        let selection = AgentLaunchSelection {
            model_id: Some("sonnet".to_string()),
            reasoning_id: None,
            mode_id: None,
            permission_mode_id: None,
            slash_command: Some("review".to_string()),
        };
        let value = serde_json::to_value(&selection).expect("serialize selection");
        assert_eq!(value["modelId"], "sonnet");
        assert_eq!(value["slashCommand"], "review");
        // The host parses this exact shape back into its own record.
        let parsed: AgentLaunchSelection =
            serde_json::from_value(value).expect("host parses selection");
        assert_eq!(parsed, selection);
    }

    #[test]
    fn prepared_launch_reads_the_host_result_and_defaults_a_missing_run_id() {
        let tracked: PreparedAgentLaunch = serde_json::from_value(serde_json::json!({
            "command": ["pragma-cli", "agent", "run", "--run-id", "r1", "--", "opencode"],
            "runId": "r1",
        }))
        .expect("tracked result");
        assert_eq!(tracked.run_id.as_deref(), Some("r1"));
        // The host omitted the line in this fixture; the wrapper forwards that
        // absence rather than inventing one.
        assert!(tracked.command_line.is_none());

        let unsupported: PreparedAgentLaunch =
            serde_json::from_value(serde_json::json!({ "command": ["opencode"] }))
                .expect("unsupported result");
        assert_eq!(unsupported.command, ["opencode"]);
        assert!(unsupported.run_id.is_none());
    }

    #[test]
    fn host_command_line_is_forwarded_verbatim_whatever_the_host_rendered() {
        // A Windows host renders PowerShell quoting for its own tab; the desktop
        // must not re-quote it (POSIX escaping would mangle the path), and the
        // same forwarding applies to a remote host's line.
        let host_line = "pragma-cli agent run --run-id r1 -- claude 'C:\\Users\\Ada''s project'";
        let tracked: PreparedAgentLaunch = serde_json::from_value(serde_json::json!({
            "command": [
                "pragma-cli",
                "agent",
                "run",
                "--run-id",
                "r1",
                "--",
                "claude",
                "C:\\Users\\Ada's project",
            ],
            "runId": "r1",
            "commandLine": host_line,
        }))
        .expect("tracked result");
        assert_eq!(tracked.command_line.as_deref(), Some(host_line));
        // Re-serializing for the webview keeps the line byte-identical.
        let forwarded = serde_json::to_value(&tracked).expect("forward result");
        assert_eq!(forwarded["commandLine"], host_line);
    }

    #[test]
    fn prepared_launch_omits_a_missing_command_line_on_the_wire() {
        let unsupported = PreparedAgentLaunch {
            command: vec!["opencode".to_string()],
            run_id: None,
            command_line: None,
        };
        let value = serde_json::to_value(&unsupported).expect("encode");
        assert!(value.get("commandLine").is_none());
    }
}
