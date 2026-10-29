//! RPC contracts for daemon-owned terminal tab metadata.

use serde::{Deserialize, Serialize};

use pragma_constants::Tab;

/// Tab metadata operations served by the host that owns the terminal session.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TabsRequest {
    /// Records an agent launched in a terminal tab and its default display title.
    SetAgent {
        tab: Box<Tab>,
        agent_id: String,
        title: String,
    },
    /// Updates an agent tab's reported session title without affecting normal tabs.
    SetTitle { tab_id: String, title: String },
    /// Returns daemon-owned agent metadata for the requested tabs.
    ListAgents { tab_ids: Vec<String> },
    /// Opens a host-owned terminal tab and its PTY in a worktree.
    ///
    /// `request_id` makes this idempotent: a double tap, or a retry after a
    /// lost response, must return the tab already created rather than leave a
    /// second shell running that nobody asked for.
    OpenTerminal {
        worktree_id: String,
        request_id: String,
        #[serde(default)]
        title: Option<String>,
    },
    /// Closes a tab and ends its process, on every device showing it.
    Close { tab_id: String },
    /// Lists the host-owned tabs in the given worktrees, plus the ids of tabs
    /// closed through the host, so a desktop can adopt the one and prune the
    /// other instead of republishing a snapshot that fights them.
    ListManaged { worktree_ids: Vec<String> },
    /// Prepares a desktop agent launch for durable recovery, before the desktop
    /// writes the command into the shell.
    ///
    /// For an agent whose plugin declares a `launch.resume` callback the host
    /// records the invocation and returns the argv wrapped in
    /// `pragma-cli agent run --run-id …`, so a crash or a native-update quit can
    /// resume the session from the record. For every other agent — and for user
    /// commands — the original `command` comes back unchanged with no `runId`.
    PrepareAgentLaunch {
        tab_id: String,
        worktree_id: String,
        agent_id: String,
        command: Vec<String>,
        /// The launch-time choices (`AgentLaunchSelection` shape). Sent as
        /// `null`/missing when the caller made none.
        #[serde(default)]
        selection: Option<serde_json::Value>,
    },
    /// Restores an interrupted agent session for one tab whose PTY is gone
    /// (a crash or a native-update quit). Returns `{ restored }`; a host that
    /// still has the live PTY reports `true` rather than spawning a duplicate.
    /// An eligible record that cannot be resumed is an error, never a silent
    /// fallback to a fresh conversation.
    RestoreAgentSession { tab_id: String, worktree_id: String },
    /// Read-only progress for this boot's automatic and on-demand recovery.
    SessionRestoreStatus,
    /// CLI-internal: the supervised child of `pragma-cli agent run` started.
    ///
    /// Marks the invocation active before the agent is exec'd. An unknown or
    /// already-finished run id is a stale report and is rejected, so a replayed
    /// command cannot revive a record the host has retired.
    StartRun { run_id: String },
    /// CLI-internal: the supervised child exited. This is the only signal that
    /// closes an invocation — never a cleared status or a watcher exiting.
    FinishRun {
        run_id: String,
        #[serde(default)]
        exit_code: Option<i32>,
        /// The server boot that authorized this execution (`startRun`'s
        /// reply). Present on every new wrapper. A report carrying a previous
        /// boot's id is stale and must not end the record the new boot is
        /// recovering; absent is the legacy wrapper, which keeps the old
        /// semantics.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_boot_id: Option<String>,
    },
    /// CLI-internal: the supervised child never started (spawn error). Keeps
    /// the record `failed` so an explicit retry can pick it up after the
    /// executable is repaired — never an ordinary `ended` completion.
    FailRun {
        run_id: String,
        reason: String,
        /// Same boot binding as [`Self::FinishRun`]: a previous boot's late
        /// spawn-failure report must not fail the record the new boot is
        /// recovering.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server_boot_id: Option<String>,
    },
}

/// Result of [`TabsRequest::PrepareAgentLaunch`].
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAgentLaunch {
    /// The argv to run: wrapped for a supported agent, unchanged otherwise.
    pub command: Vec<String>,
    /// The tracked run id, present only when the host recorded an invocation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// `command` already quoted for the shell the tab actually runs, when the
    /// host can tell: the live session's own program, else the owning host's
    /// project/global `terminal` config resolved the way the spawn resolves
    /// it. A caller that types this line never has to guess the quoting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_line: Option<String>,
}

/// Result of [`TabsRequest::RestoreAgentSession`].
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreAgentSessionResult {
    /// True when the session is live again (restored now, or still attached).
    pub restored: bool,
}

/// Recovery progress retained for the lifetime of one host boot.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRestoreSnapshot {
    /// Identifies this report, not a harness conversation or execution.
    pub boot_id: String,
    /// False while startup may still discover more interrupted sessions.
    pub startup_complete: bool,
    pub sessions: Vec<SessionRestoreProgress>,
}

/// One attempted restore; absence of an outcome means it is still running.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRestoreProgress {
    pub tab_id: String,
    /// Enriched by the desktop adapter when its local tab metadata is available.
    #[serde(default)]
    pub title: String,
    pub complete: bool,
    pub error: Option<String>,
}

/// Host-owned tab state a desktop reconciles its own rows against.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedTabsResult {
    pub tabs: Vec<Tab>,
    /// Ids of tabs closed through the host. A desktop row with one of these
    /// ids is stale and must be deleted, not republished.
    pub closed_tab_ids: Vec<String>,
}

/// Durable daemon-owned agent metadata for one terminal tab.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabAgentMetadata {
    pub tab_id: String,
    pub agent_id: String,
    pub title: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every client that sends these requests — the SDK, the phone, the
    // gateway — speaks camelCase on the wire. A snake_case field name here is
    // not a cosmetic mismatch: the request fails to deserialize, and a caller
    // waiting for its RPC reply never gets one.
    #[test]
    fn reads_camel_case_fields() {
        let request: TabsRequest =
            serde_json::from_str(r#"{"action":"listManaged","worktreeIds":["w1"]}"#)
                .expect("a client sends camelCase");

        match request {
            TabsRequest::ListManaged { worktree_ids } => assert_eq!(worktree_ids, ["w1"]),
            other => panic!("expected listManaged, got {other:?}"),
        }
    }

    #[test]
    fn reads_a_camel_case_open_terminal() {
        let request: TabsRequest =
            serde_json::from_str(r#"{"action":"openTerminal","worktreeId":"w1","requestId":"r1"}"#)
                .expect("a client sends camelCase");

        match request {
            TabsRequest::OpenTerminal {
                worktree_id,
                request_id,
                title,
            } => {
                assert_eq!(worktree_id, "w1");
                assert_eq!(request_id, "r1");
                assert_eq!(title, None);
            }
            other => panic!("expected openTerminal, got {other:?}"),
        }
    }

    #[test]
    fn writes_camel_case_fields() {
        let json = serde_json::to_value(TabsRequest::Close {
            tab_id: "t1".to_string(),
        })
        .expect("the request serializes");

        assert_eq!(
            json,
            serde_json::json!({ "action": "close", "tabId": "t1" })
        );
    }

    #[test]
    fn reads_a_prepare_agent_launch() {
        let request: TabsRequest = serde_json::from_str(
            r#"{"action":"prepareAgentLaunch","tabId":"t1","worktreeId":"w1","agentId":"pragma.claude-code","command":["claude"],"selection":{"modelId":"sonnet","reasoningId":null,"modeId":null,"permissionModeId":null,"slashCommand":null}}"#,
        )
        .expect("a desktop sends camelCase");

        match request {
            TabsRequest::PrepareAgentLaunch {
                tab_id,
                worktree_id,
                agent_id,
                command,
                selection,
            } => {
                assert_eq!(tab_id, "t1");
                assert_eq!(worktree_id, "w1");
                assert_eq!(agent_id, "pragma.claude-code");
                assert_eq!(command, ["claude"]);
                assert_eq!(selection.unwrap()["modelId"], "sonnet");
            }
            other => panic!("expected prepareAgentLaunch, got {other:?}"),
        }
    }

    #[test]
    fn reads_a_prepare_agent_launch_without_a_selection() {
        // The desktop sends `selection: null` when the caller made no choices.
        let request: TabsRequest = serde_json::from_str(
            r#"{"action":"prepareAgentLaunch","tabId":"t1","worktreeId":"w1","agentId":"a","command":["a"],"selection":null}"#,
        )
        .expect("camelCase with a null selection");
        match request {
            TabsRequest::PrepareAgentLaunch { selection, .. } => assert!(selection.is_none()),
            other => panic!("expected prepareAgentLaunch, got {other:?}"),
        }
    }

    #[test]
    fn prepared_launch_carries_an_optional_command_line() {
        let prepared = PreparedAgentLaunch {
            command: vec!["claude".to_string()],
            run_id: None,
            command_line: Some("claude".to_string()),
        };
        let json = serde_json::to_value(&prepared).expect("serializes");
        assert_eq!(json["commandLine"], "claude");
        let bare: PreparedAgentLaunch = serde_json::from_value(serde_json::json!({
            "command": ["claude"],
        }))
        .expect("an older host omits it");
        assert!(bare.command_line.is_none());
    }

    #[test]
    fn reads_restore_and_run_lifecycle_ops() {
        let restore: TabsRequest = serde_json::from_str(
            r#"{"action":"restoreAgentSession","tabId":"t1","worktreeId":"w1"}"#,
        )
        .expect("a desktop sends camelCase");
        assert!(matches!(
            restore,
            TabsRequest::RestoreAgentSession { tab_id, worktree_id }
                if tab_id == "t1" && worktree_id == "w1"
        ));

        let started: TabsRequest = serde_json::from_str(r#"{"action":"startRun","runId":"r1"}"#)
            .expect("the CLI sends camelCase");
        assert!(matches!(
            started,
            TabsRequest::StartRun { run_id } if run_id == "r1"
        ));

        let finished: TabsRequest =
            serde_json::from_str(r#"{"action":"finishRun","runId":"r1","exitCode":0}"#)
                .expect("the CLI sends camelCase");
        assert!(matches!(
            finished,
            TabsRequest::FinishRun {
                run_id,
                exit_code: Some(0),
                server_boot_id: None,
            } if run_id == "r1"
        ));

        let boot_bound: TabsRequest = serde_json::from_str(
            r#"{"action":"finishRun","runId":"r1","exitCode":0,"serverBootId":"boot-1"}"#,
        )
        .expect("a new wrapper carries the authorizing boot");
        assert!(matches!(
            boot_bound,
            TabsRequest::FinishRun {
                server_boot_id: Some(id),
                ..
            } if id == "boot-1"
        ));

        let failed: TabsRequest = serde_json::from_str(
            r#"{"action":"failRun","runId":"r1","reason":"could not run agent: No such file","serverBootId":"boot-1"}"#,
        )
        .expect("a spawn failure carries the authorizing boot");
        assert!(matches!(
            failed,
            TabsRequest::FailRun {
                run_id,
                reason,
                server_boot_id: Some(id),
            } if run_id == "r1"
                && reason.contains("No such file")
                && id == "boot-1"
        ));
    }
}
