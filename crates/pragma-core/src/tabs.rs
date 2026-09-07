//! RPC contracts for daemon-owned terminal tab metadata.

use serde::{Deserialize, Serialize};

use pragma_constants::Tab;

/// Tab metadata operations served by the host that owns the terminal session.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
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
