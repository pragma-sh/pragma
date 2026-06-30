//! Worktree-scoped filesystem commands.
//!
//! Each command takes a `worktree_id` and a worktree-relative path. The trusted
//! absolute worktree root is looked up from the local DB (never trusted from the
//! frontend) and forwarded — with the relative path — to the project's host via
//! the `filesystem` RPC. The host (`pragma-core`) re-validates the path against
//! escaping the worktree and performs the actual disk access, so the same
//! command serves a local project and an SSH-bridged remote one.

use std::path::{Path, PathBuf};

use pragma_constants::{DirEntry, FileContents, ProtocolRpcMethod};
use pragma_core::fs::FsRequest;
use serde::de::DeserializeOwned;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::hosts::Hosts;
use crate::pty::PtyClient;
use crate::ssh_host;

/// Re-validates a worktree-relative path against escaping the worktree, returning
/// the resolved absolute path. Used by callers that still touch the local disk
/// directly (PR diffs, AI helpers); the core RPC path validates host-side.
pub(crate) fn resolve_in_worktree(root: &Path, relative: &str) -> AppResult<PathBuf> {
    pragma_core::fs::resolve_in_worktree(root, relative)
        .map_err(|error| AppError::InvalidInput(error.to_string()))
}

/// Looks up a worktree's trusted absolute root path from the DB.
fn worktree_root(db: &Db, worktree_id: &str) -> AppResult<String> {
    Ok(db.worktree(worktree_id)?.path)
}

/// Sends a `filesystem` RPC and decodes its JSON response into `T`.
fn fs_rpc<T: DeserializeOwned>(pty: &PtyClient, request: &FsRequest) -> AppResult<T> {
    let payload = serde_json::to_value(request)?;
    let value = pty.rpc(ProtocolRpcMethod::Filesystem, payload)?;
    Ok(serde_json::from_value(value)?)
}

/// Lists the immediate entries of a worktree-relative directory (`""` = root).
#[tauri::command]
pub async fn list_dir_entries(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    path: String,
) -> AppResult<Vec<DirEntry>> {
    let root = worktree_root(&db, &worktree_id)?;
    let pty = ssh_host::client_for_worktree(app, &db, &hosts, &worktree_id).await?;
    fs_rpc(&pty, &FsRequest::ListDir { root, path })
}

/// Creates an empty file at a worktree-relative path.
#[tauri::command]
pub async fn create_file(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    path: String,
) -> AppResult<()> {
    let root = worktree_root(&db, &worktree_id)?;
    let pty = ssh_host::client_for_worktree(app, &db, &hosts, &worktree_id).await?;
    fs_rpc(&pty, &FsRequest::CreateFile { root, path })
}

/// Creates a directory at a worktree-relative path.
#[tauri::command]
pub async fn create_folder(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    path: String,
) -> AppResult<()> {
    let root = worktree_root(&db, &worktree_id)?;
    let pty = ssh_host::client_for_worktree(app, &db, &hosts, &worktree_id).await?;
    fs_rpc(&pty, &FsRequest::CreateFolder { root, path })
}

/// Reports whether a worktree-relative path exists on disk.
#[tauri::command]
pub async fn path_exists(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    path: String,
) -> AppResult<bool> {
    let root = worktree_root(&db, &worktree_id)?;
    let pty = ssh_host::client_for_worktree(app, &db, &hosts, &worktree_id).await?;
    fs_rpc(&pty, &FsRequest::PathExists { root, path })
}

/// Reads a worktree-relative file.
#[tauri::command]
pub async fn read_file(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    path: String,
) -> AppResult<FileContents> {
    let root = worktree_root(&db, &worktree_id)?;
    let pty = ssh_host::client_for_worktree(app, &db, &hosts, &worktree_id).await?;
    fs_rpc(&pty, &FsRequest::ReadFile { root, path })
}

/// Overwrites a worktree-relative file with UTF-8 text.
#[tauri::command]
pub async fn write_file(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    path: String,
    contents: String,
) -> AppResult<()> {
    let root = worktree_root(&db, &worktree_id)?;
    let pty = ssh_host::client_for_worktree(app, &db, &hosts, &worktree_id).await?;
    fs_rpc(
        &pty,
        &FsRequest::WriteFile {
            root,
            path,
            contents,
        },
    )
}

/// Renames (or moves) a worktree-relative entry.
#[tauri::command]
pub async fn rename_file(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    from_path: String,
    to_path: String,
) -> AppResult<()> {
    let root = worktree_root(&db, &worktree_id)?;
    let pty = ssh_host::client_for_worktree(app, &db, &hosts, &worktree_id).await?;
    fs_rpc(
        &pty,
        &FsRequest::Rename {
            root,
            from: from_path,
            to: to_path,
        },
    )
}

/// Deletes a worktree-relative file or empty directory.
#[tauri::command]
pub async fn delete_file(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    path: String,
) -> AppResult<()> {
    let root = worktree_root(&db, &worktree_id)?;
    let pty = ssh_host::client_for_worktree(app, &db, &hosts, &worktree_id).await?;
    fs_rpc(&pty, &FsRequest::Delete { root, path })
}
