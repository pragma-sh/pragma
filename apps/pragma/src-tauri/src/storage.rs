//! Settings → Storage commands.
//!
//! Each command resolves the worktree's trusted root from the local DB and
//! forwards to the owning host's storage operations (`pragma_core::storage`)
//! over the `filesystem` RPC, so a remote project is measured — and cleaned —
//! on the machine whose disk it actually fills. A scan walks a whole tree, so
//! every command runs off the main thread.

use pragma_constants::WorktreeStorage;
use pragma_core::fs::FsRequest;
use serde::de::DeserializeOwned;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::fs::fs_rpc;
use crate::hosts::Hosts;
use crate::ssh_host;

/// Sends one storage request to the host that owns `worktree_id`.
async fn storage_rpc<T: DeserializeOwned + Send + 'static>(
    app: tauri::AppHandle,
    db: &Db,
    hosts: &Hosts,
    worktree_id: &str,
    request: FsRequest,
) -> AppResult<T> {
    let pty = ssh_host::client_for_worktree(app, db, hosts, worktree_id).await?;
    tauri::async_runtime::spawn_blocking(move || fs_rpc(&pty, &request))
        .await
        .map_err(|error| AppError::Daemon(format!("storage task failed: {error}")))?
}

/// Measures one worktree's disk usage. `scan_id` lets the page cancel it.
#[tauri::command]
pub async fn scan_worktree_storage(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    scan_id: String,
) -> AppResult<WorktreeStorage> {
    let root = db.worktree(&worktree_id)?.path;
    storage_rpc(
        app,
        &db,
        &hosts,
        &worktree_id,
        FsRequest::StorageScan { scan_id, root },
    )
    .await
}

/// Stops a running worktree storage scan. Safe after it has finished.
#[tauri::command]
pub async fn cancel_worktree_storage_scan(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    scan_id: String,
) -> AppResult<()> {
    storage_rpc(
        app,
        &db,
        &hosts,
        &worktree_id,
        FsRequest::CancelStorageScan { scan_id },
    )
    .await
}

/// Deletes one gitignored folder; the host re-checks it is safe to delete.
#[tauri::command]
pub async fn delete_ignored_folder(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    path: String,
) -> AppResult<()> {
    let root = db.worktree(&worktree_id)?.path;
    storage_rpc(
        app,
        &db,
        &hosts,
        &worktree_id,
        FsRequest::DeleteIgnoredFolder { root, path },
    )
    .await
}
