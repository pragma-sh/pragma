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
}

/// Durable daemon-owned agent metadata for one terminal tab.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabAgentMetadata {
    pub tab_id: String,
    pub agent_id: String,
    pub title: Option<String>,
}
