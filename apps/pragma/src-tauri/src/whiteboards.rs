//! Thin desktop adapter for host-owned whiteboards and client tab projections.

use pragma_constants::{
    ExcalidrawScene, ProtocolRpcMethod, Tab, Whiteboard, WhiteboardEditInput, WhiteboardViewResult,
};
use pragma_core::whiteboards::WhiteboardsRequest;
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::AppResult;
use crate::hosts::Hosts;
use crate::workspace_mirror::WorkspacePublisher;

async fn rpc<T: serde::de::DeserializeOwned>(
    app: AppHandle,
    db: &Db,
    hosts: &Hosts,
    worktree_id: &str,
    request: WhiteboardsRequest,
) -> AppResult<T> {
    let client = crate::ssh_host::client_for_worktree(app, db, hosts, worktree_id).await?;
    let value = client.rpc(
        ProtocolRpcMethod::Whiteboards,
        serde_json::to_value(request)?,
    )?;
    Ok(serde_json::from_value(value)?)
}

/// Creates a host-owned whiteboard without opening a desktop tab.
#[tauri::command]
pub async fn create_whiteboard(
    app: AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    title: String,
    scene: ExcalidrawScene,
) -> AppResult<Whiteboard> {
    rpc(
        app,
        &db,
        &hosts,
        &worktree_id,
        WhiteboardsRequest::Create {
            worktree_id: worktree_id.clone(),
            title,
            scene,
        },
    )
    .await
}

/// Gets one whiteboard from its owning host.
#[tauri::command]
pub async fn get_whiteboard(
    app: AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    id: String,
) -> AppResult<Whiteboard> {
    rpc(
        app,
        &db,
        &hosts,
        &worktree_id,
        WhiteboardsRequest::Get {
            worktree_id: worktree_id.clone(),
            id,
        },
    )
    .await
}

/// Lists or searches whiteboards scoped to one worktree.
#[tauri::command]
pub async fn list_whiteboards(
    app: AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    query: Option<String>,
) -> AppResult<Vec<Whiteboard>> {
    rpc(
        app,
        &db,
        &hosts,
        &worktree_id,
        WhiteboardsRequest::List {
            worktree_id: worktree_id.clone(),
            query,
        },
    )
    .await
}

/// Replaces one whiteboard after an optimistic version check.
#[tauri::command]
pub async fn edit_whiteboard(
    app: AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    input: WhiteboardEditInput,
) -> AppResult<Whiteboard> {
    let worktree_id = input.worktree_id.clone();
    rpc(
        app,
        &db,
        &hosts,
        &worktree_id,
        WhiteboardsRequest::Edit {
            worktree_id: worktree_id.clone(),
            id: input.id,
            title: input.title,
            scene: input.scene,
            expected_version: input.expected_version.get(),
        },
    )
    .await
}

/// Deletes one host-owned whiteboard.
#[tauri::command]
pub async fn delete_whiteboard(
    app: AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    id: String,
) -> AppResult<()> {
    rpc(
        app,
        &db,
        &hosts,
        &worktree_id,
        WhiteboardsRequest::Delete {
            worktree_id: worktree_id.clone(),
            id,
        },
    )
    .await
}

/// Renders one host-owned whiteboard as a base64 PNG.
#[tauri::command]
pub async fn view_whiteboard(
    app: AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    id: String,
    dark: bool,
) -> AppResult<WhiteboardViewResult> {
    rpc(
        app,
        &db,
        &hosts,
        &worktree_id,
        WhiteboardsRequest::View {
            worktree_id: worktree_id.clone(),
            id,
            dark,
        },
    )
    .await
}

/// Opens one whiteboard as a file-like tab, deduplicated by board id.
#[tauri::command]
pub fn open_whiteboard_tab(
    db: State<'_, Db>,
    publisher: State<'_, WorkspacePublisher>,
    worktree_id: String,
    whiteboard_id: String,
    title: String,
) -> AppResult<Tab> {
    let worktree = db.worktree(&worktree_id)?;
    let tab =
        db.create_whiteboard_tab(&worktree.project_id, &worktree_id, &whiteboard_id, title)?;
    publisher.trigger();
    Ok(tab)
}
