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
}
