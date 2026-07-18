use pragma_constants::{OpenPort, ProtocolRpcMethod};
use serde_json::json;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::hosts::Hosts;
use crate::ssh_host;

/// Lists TCP listeners owned by terminal tabs in visible project worktrees.
#[tauri::command]
pub async fn list_open_ports(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    project_id: String,
) -> AppResult<Vec<OpenPort>> {
    let worktrees = db
        .list_worktrees(&project_id)?
        .into_iter()
        .filter(|worktree| !worktree.hidden)
        .collect::<Vec<_>>();
    let Some(route) = worktrees.first() else {
        return Ok(Vec::new());
    };
    let client = ssh_host::client_for_worktree(app, &db, &hosts, &route.id).await?;
    let worktree_ids = worktrees
        .into_iter()
        .map(|worktree| worktree.id)
        .collect::<Vec<_>>();
    tauri::async_runtime::spawn_blocking(move || {
        let value = client.rpc(
            ProtocolRpcMethod::Ports,
            json!({ "worktreeIds": worktree_ids }),
        )?;
        serde_json::from_value(value).map_err(|error| AppError::Daemon(error.to_string()))
    })
    .await
    .map_err(|error| AppError::Daemon(format!("port inspection task failed: {error}")))?
}
