//! Scratchpad-to-agent interaction routed through the worktree's owning host.

use pragma_constants::{
    AgentInput, FileContents, ProtocolRpcMethod, ScratchpadSummary, Tab, TabKind, CONSTANTS,
};
use pragma_core::fs::FsRequest;
use pragma_core::tabs::{TabAgentMetadata, TabsRequest};
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::fs::fs_rpc;
use crate::hosts::Hosts;
use crate::pty::PtyClient;
use crate::workspace_mirror::WorkspacePublisher;

/// Resolves daemon-owned agent metadata for a terminal tab.
pub fn registered_agent_id(client: &PtyClient, tab: &Tab) -> AppResult<String> {
    if let Some(agent_id) = &tab.agent_id {
        return Ok(agent_id.clone());
    }
    let value = client.rpc(
        ProtocolRpcMethod::Tabs,
        serde_json::to_value(TabsRequest::ListAgents {
            tab_ids: vec![tab.id.clone()],
        })?,
    )?;
    let metadata: Vec<TabAgentMetadata> = serde_json::from_value(value)?;
    agent_id_from_metadata(&tab.id, &metadata)
}

fn agent_id_from_metadata(tab_id: &str, metadata: &[TabAgentMetadata]) -> AppResult<String> {
    metadata
        .iter()
        .find(|entry| entry.tab_id == tab_id)
        .map(|entry| entry.agent_id.clone())
        .ok_or_else(|| {
            AppError::InvalidInput("attached tab is not a registered agent tab".to_string())
        })
}

/// Sends one scratchpad prompt to its attached agent tab.
#[tauri::command]
pub async fn scratchpad_prompt_agent(
    app: AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    tab_id: String,
    text: String,
) -> AppResult<()> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::InvalidInput(
            "agent prompt cannot be empty".to_string(),
        ));
    }
    let tab = db.tab_by_id_or_prefix(&tab_id)?;
    if tab.worktree_id != worktree_id || !matches!(tab.kind, TabKind::Terminal) {
        return Err(AppError::InvalidInput(
            "attached agent tab is not in this scratchpad's worktree".to_string(),
        ));
    }
    let client = crate::ssh_host::client_for_worktree(app, &db, &hosts, &worktree_id).await?;
    let catalog_agent_id = registered_agent_id(&client, &tab)?;
    let agent = catalog_agent_id
        .rsplit('.')
        .next()
        .unwrap_or(&catalog_agent_id)
        .to_string();
    client.report_agent_input(&AgentInput {
        agent,
        worktree_id,
        tab_id: tab.id,
        text: text.to_string(),
        request_id: None,
    })
}

#[derive(Deserialize)]
struct ScratchpadFrontmatter {
    id: String,
    title: String,
}

/// Lists every managed scratchpad file in a worktree's scratchpad directory,
/// including ones whose tab was closed after creation.
#[tauri::command]
pub async fn list_scratchpads(
    app: AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
) -> AppResult<Vec<ScratchpadSummary>> {
    let worktree = db.worktree(&worktree_id)?;
    let client = crate::ssh_host::client_for_worktree(app, &db, &hosts, &worktree_id).await?;
    let names: Vec<String> = fs_rpc(
        &client,
        &FsRequest::ListFileNames {
            root: worktree.path.clone(),
            path: CONSTANTS.scratchpads.directory.clone(),
            extensions: vec![CONSTANTS.scratchpads.extension.clone()],
        },
    )?;
    let mut summaries = Vec::with_capacity(names.len());
    for name in names {
        let file_path = format!("{}/{name}", CONSTANTS.scratchpads.directory);
        let contents: FileContents = fs_rpc(
            &client,
            &FsRequest::ReadFile {
                root: worktree.path.clone(),
                path: file_path.clone(),
            },
        )?;
        if contents.binary || contents.truncated {
            continue;
        }
        if let Some(frontmatter) = parse_frontmatter(&contents.text) {
            summaries.push(ScratchpadSummary {
                id: frontmatter.id,
                title: frontmatter.title,
                file_path,
            });
        }
    }
    Ok(summaries)
}

fn parse_frontmatter(source: &str) -> Option<ScratchpadFrontmatter> {
    let prefix = format!("{}: ", CONSTANTS.scratchpads.frontmatter_key);
    let json = source.lines().find_map(|line| line.strip_prefix(&prefix))?;
    serde_json::from_str(json).ok()
}

/// Opens a tab for an existing scratchpad file, reusing an already-open tab
/// for the same file instead of creating a duplicate.
#[tauri::command]
pub fn open_scratchpad_tab(
    db: State<'_, Db>,
    publisher: State<'_, WorkspacePublisher>,
    worktree_id: String,
    file_path: String,
    title: String,
) -> AppResult<Tab> {
    let worktree = db.worktree(&worktree_id)?;
    let existing = db.list_tabs(&worktree.project_id)?.into_iter().find(|tab| {
        matches!(tab.kind, TabKind::Scratchpad)
            && tab.worktree_id == worktree_id
            && tab.file_path.as_deref() == Some(file_path.as_str())
    });
    if let Some(tab) = existing {
        return Ok(tab);
    }
    let tab = db.create_tab(
        &worktree.project_id,
        &worktree_id,
        TabKind::Scratchpad,
        Some(title),
        None,
        Some(file_path),
        None,
        None,
        None,
        None,
    )?;
    publisher.trigger();
    Ok(tab)
}

#[cfg(test)]
mod tests {
    use pragma_core::tabs::TabAgentMetadata;

    use super::agent_id_from_metadata;

    #[test]
    fn resolves_agent_id_from_daemon_metadata() {
        let metadata = [TabAgentMetadata {
            tab_id: "tab-1".to_string(),
            agent_id: "opencode".to_string(),
            title: Some("OpenCode".to_string()),
        }];

        assert_eq!(
            agent_id_from_metadata("tab-1", &metadata).expect("metadata should resolve"),
            "opencode",
        );
    }
}
