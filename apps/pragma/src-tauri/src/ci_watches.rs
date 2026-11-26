//! Thin desktop adapter for host-owned CI watch records.
//!
//! The record lives on the worktree's owning host (`pragma-core::ci_watches`)
//! so `pragma-cli ci` and agents see and disarm the same watch the PR pane
//! armed. The desktop only forwards the shared `{ action, … }` payload.

use pragma_constants::ProtocolRpcMethod;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::hosts::Hosts;

/// Forwards one `ciWatches` RPC to the host that owns `worktree_id`.
///
/// Runs on a blocking worker because `client.rpc` blocks on the host socket.
#[tauri::command]
pub async fn ci_watch_rpc(
    app: AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    payload: Value,
) -> AppResult<Value> {
    let client = crate::ssh_host::client_for_worktree(app, &db, &hosts, &worktree_id).await?;
    tauri::async_runtime::spawn_blocking(move || client.rpc(ProtocolRpcMethod::CiWatches, payload))
        .await
        .map_err(|error| AppError::Daemon(format!("ci watch task failed: {error}")))?
}
