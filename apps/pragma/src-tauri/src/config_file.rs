//! Global/project `.pragma` file access for Settings controls.
//!
//! `config.json`, `keybindings.json`, and the optional `theme.json` are edited
//! the same way — a global file under the home directory and a per-project file
//! under the project's main worktree — so all three go through one scoped
//! reader/writer. Project files are reached over the owning host's filesystem
//! RPC, which keeps SSH-bridged projects working without a second code path.

use std::io::Write;
use std::path::PathBuf;

use pragma_constants::CONSTANTS;
use pragma_core::fs::FsRequest;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::fs::fs_rpc;
use crate::hosts::Hosts;
use crate::pty::PtyClient;
use crate::ssh_host;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigScope {
    Global,
    Project,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocument {
    pub exists: bool,
    pub contents: String,
    pub path: String,
}

fn starter_document(path: String) -> ConfigDocument {
    ConfigDocument {
        exists: false,
        contents: "{\n}\n".to_string(),
        path,
    }
}

fn project_main_worktree(db: &Db, project_id: &str) -> AppResult<pragma_constants::Worktree> {
    db.list_worktrees(project_id)?
        .into_iter()
        .find(|worktree| worktree.is_main)
        .ok_or_else(|| AppError::InvalidInput("project has no main worktree".to_string()))
}

/// Reads one scoped `.pragma` file, returning a starter document when it is missing.
pub(crate) async fn read_scoped(
    app: tauri::AppHandle,
    db: &Db,
    hosts: &Hosts,
    scope: ConfigScope,
    project_id: Option<String>,
    relative: &str,
) -> AppResult<ConfigDocument> {
    match scope {
        ConfigScope::Global => read_local(app.path().home_dir()?.join(relative)).await,
        ConfigScope::Project => {
            let worktree = scoped_project_worktree(db, project_id)?;
            let client = ssh_host::client_for_worktree(app, db, hosts, &worktree.id).await?;
            let display_path = format!("{}/{relative}", worktree.path);
            let exists: bool = fs_rpc(
                &client,
                &FsRequest::PathExists {
                    root: worktree.path.clone(),
                    path: relative.to_string(),
                },
            )?;
            if !exists {
                return Ok(starter_document(display_path));
            }
            let file: pragma_constants::FileContents = fs_rpc(
                &client,
                &FsRequest::ReadFile {
                    root: worktree.path,
                    path: relative.to_string(),
                },
            )?;
            if file.binary || file.truncated {
                return Err(AppError::InvalidInput(format!(
                    "{relative} must be a small UTF-8 text file"
                )));
            }
            Ok(ConfigDocument {
                exists: true,
                contents: file.text,
                path: display_path,
            })
        }
    }
}

/// Writes one scoped `.pragma` file, creating its parent directory when needed.
pub(crate) async fn write_scoped(
    app: tauri::AppHandle,
    db: &Db,
    hosts: &Hosts,
    scope: ConfigScope,
    project_id: Option<String>,
    relative: &str,
    contents: String,
) -> AppResult<Option<PtyClient>> {
    match scope {
        ConfigScope::Global => {
            write_local(app.path().home_dir()?.join(relative), contents).await?;
            Ok(None)
        }
        ConfigScope::Project => {
            let worktree = scoped_project_worktree(db, project_id)?;
            let client = ssh_host::client_for_worktree(app, db, hosts, &worktree.id).await?;
            if let Some(parent) = std::path::Path::new(relative)
                .parent()
                .and_then(std::path::Path::to_str)
                .filter(|parent| !parent.is_empty())
            {
                ensure_host_dir(&client, &worktree.path, parent)?;
            }
            fs_rpc::<()>(
                &client,
                &FsRequest::WriteFile {
                    root: worktree.path,
                    path: relative.to_string(),
                    contents,
                },
            )?;
            Ok(Some(client))
        }
    }
}

/// Resolves the main worktree a project-scoped `.pragma` path hangs off, which is
/// also the root every project-scoped filesystem RPC is relative to.
pub(crate) fn scoped_project_worktree(
    db: &Db,
    project_id: Option<String>,
) -> AppResult<pragma_constants::Worktree> {
    let project_id = project_id
        .ok_or_else(|| AppError::InvalidInput("project scope requires projectId".to_string()))?;
    project_main_worktree(db, &project_id)
}

/// Creates each missing ancestor of `relative` under `root` on the owning host.
pub(crate) fn ensure_host_dir(client: &PtyClient, root: &str, relative: &str) -> AppResult<()> {
    let mut current = String::new();
    for segment in relative.split('/').filter(|segment| !segment.is_empty()) {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(segment);
        let exists: bool = fs_rpc(
            client,
            &FsRequest::PathExists {
                root: root.to_string(),
                path: current.clone(),
            },
        )?;
        if !exists {
            fs_rpc::<()>(
                client,
                &FsRequest::CreateFolder {
                    root: root.to_string(),
                    path: current.clone(),
                },
            )?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn read_config(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    scope: ConfigScope,
    project_id: Option<String>,
) -> AppResult<ConfigDocument> {
    read_scoped(
        app,
        &db,
        &hosts,
        scope,
        project_id,
        CONSTANTS.plugins.config_file_name.as_str(),
    )
    .await
}

#[tauri::command]
pub async fn write_config(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    pty: State<'_, PtyClient>,
    scope: ConfigScope,
    project_id: Option<String>,
    contents: String,
) -> AppResult<()> {
    let host = write_scoped(
        app,
        &db,
        &hosts,
        scope,
        project_id,
        CONSTANTS.plugins.config_file_name.as_str(),
        contents,
    )
    .await?;
    let client = host.as_ref().unwrap_or(&pty);
    if let Err(error) = reload_plugins(client) {
        log::warn!("config saved but plugin reload failed: {error}");
    }
    Ok(())
}

/// Reads the global or project `keybindings.json` verbatim so Settings can patch
/// exactly the actions the user recorded and leave hand-edits alone.
#[tauri::command]
pub async fn read_keybindings_file(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    scope: ConfigScope,
    project_id: Option<String>,
) -> AppResult<ConfigDocument> {
    read_scoped(
        app,
        &db,
        &hosts,
        scope,
        project_id,
        CONSTANTS.keybindings.config_file_name.as_str(),
    )
    .await
}

/// Writes the global or project `keybindings.json` after checking that it still
/// merges into a valid config, so a bad write can never break every shortcut.
#[tauri::command]
pub async fn write_keybindings_file(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    scope: ConfigScope,
    project_id: Option<String>,
    contents: String,
) -> AppResult<()> {
    crate::keybindings::validate_overrides(&contents)?;
    write_scoped(
        app,
        &db,
        &hosts,
        scope,
        project_id,
        CONSTANTS.keybindings.config_file_name.as_str(),
        contents,
    )
    .await?;
    Ok(())
}

/// Reads the optional `.pragma/theme.json` color overrides for a scope. A
/// missing file is not an error — the frontend treats it as "no overrides".
#[tauri::command]
pub async fn read_theme(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    scope: ConfigScope,
    project_id: Option<String>,
) -> AppResult<ConfigDocument> {
    read_scoped(
        app,
        &db,
        &hosts,
        scope,
        project_id,
        CONSTANTS.theme.file_name.as_str(),
    )
    .await
}

/// Writes `.pragma/theme.json` for a scope. Unlike `config.json` this needs no
/// plugin reload — the frontend re-applies the CSS variables itself.
#[tauri::command]
pub async fn write_theme(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    scope: ConfigScope,
    project_id: Option<String>,
    contents: String,
) -> AppResult<()> {
    write_scoped(
        app,
        &db,
        &hosts,
        scope,
        project_id,
        CONSTANTS.theme.file_name.as_str(),
        contents,
    )
    .await?;
    Ok(())
}

fn reload_plugins(client: &PtyClient) -> AppResult<()> {
    client.rpc(
        pragma_constants::ProtocolRpcMethod::Plugins,
        serde_json::json!({ "action": "reload" }),
    )?;
    Ok(())
}

async fn read_local(path: PathBuf) -> AppResult<ConfigDocument> {
    let display_path = path.display().to_string();
    tauri::async_runtime::spawn_blocking(move || match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(ConfigDocument {
            exists: true,
            contents,
            path: display_path,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(starter_document(display_path))
        }
        Err(error) => Err(AppError::Io(error)),
    })
    .await
    .map_err(|error| AppError::InvalidInput(error.to_string()))?
}

async fn write_local(path: PathBuf, contents: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let temp_path = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
        let mut file = pragma_platform::perms::create_private_file(&temp_path)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(temp_path, path)?;
        Ok(())
    })
    .await
    .map_err(|error| AppError::InvalidInput(error.to_string()))?
}
