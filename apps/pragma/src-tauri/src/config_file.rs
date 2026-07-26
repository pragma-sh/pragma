//! Global/project `.pragma/*.json` access for Settings controls.
//!
//! Two documents share this plumbing: `.pragma/config.json` (plugins, tunnel) and
//! the optional `.pragma/theme.json` (color overrides). Both resolve against the
//! home directory in [`ConfigScope::Global`] and against the project's main
//! worktree in [`ConfigScope::Project`], so remote/SSH projects go over the same
//! `fs_rpc` path as local ones.

use std::io::Write;
use std::path::PathBuf;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

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

/// The host handles a scoped read/write needs, bundled so the helpers below
/// stay within clippy's argument budget.
struct ScopeHandles<'a> {
    app: tauri::AppHandle,
    db: &'a Db,
    hosts: &'a Hosts,
    /// The local host client, used when the scope is global.
    pty: &'a PtyClient,
}

fn project_main_worktree(db: &Db, project_id: &str) -> AppResult<pragma_constants::Worktree> {
    db.list_worktrees(project_id)?
        .into_iter()
        .find(|worktree| worktree.is_main)
        .ok_or_else(|| AppError::InvalidInput("project has no main worktree".to_string()))
}

#[tauri::command]
pub async fn read_config(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    pty: State<'_, PtyClient>,
    scope: ConfigScope,
    project_id: Option<String>,
) -> AppResult<ConfigDocument> {
    let handles = ScopeHandles {
        app,
        db: &db,
        hosts: &hosts,
        pty: &pty,
    };
    read_scoped(
        handles,
        scope,
        project_id,
        CONSTANTS.plugins.config_file_name.clone(),
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
    let handles = ScopeHandles {
        app,
        db: &db,
        hosts: &hosts,
        pty: &pty,
    };
    let client = write_scoped(
        handles,
        scope,
        project_id,
        CONSTANTS.plugins.config_file_name.clone(),
        contents,
    )
    .await?;
    if let Err(error) = reload_plugins(&client) {
        log::warn!("config saved but plugin reload failed: {error}");
    }
    Ok(())
}

/// Reads the optional `.pragma/theme.json` color overrides for a scope. A
/// missing file is not an error — the frontend treats it as "no overrides".
#[tauri::command]
pub async fn read_theme(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    pty: State<'_, PtyClient>,
    scope: ConfigScope,
    project_id: Option<String>,
) -> AppResult<ConfigDocument> {
    let handles = ScopeHandles {
        app,
        db: &db,
        hosts: &hosts,
        pty: &pty,
    };
    read_scoped(
        handles,
        scope,
        project_id,
        CONSTANTS.theme.file_name.clone(),
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
    pty: State<'_, PtyClient>,
    scope: ConfigScope,
    project_id: Option<String>,
    contents: String,
) -> AppResult<()> {
    let handles = ScopeHandles {
        app,
        db: &db,
        hosts: &hosts,
        pty: &pty,
    };
    write_scoped(
        handles,
        scope,
        project_id,
        CONSTANTS.theme.file_name.clone(),
        contents,
    )
    .await?;
    Ok(())
}

async fn read_scoped(
    handles: ScopeHandles<'_>,
    scope: ConfigScope,
    project_id: Option<String>,
    relative: String,
) -> AppResult<ConfigDocument> {
    let ScopeHandles { app, db, hosts, .. } = handles;
    match scope {
        ConfigScope::Global => read_local(app.path().home_dir()?.join(relative.as_str())).await,
        ConfigScope::Project => {
            let worktree = project_main_worktree(db, &require_project_id(project_id)?)?;
            let client = ssh_host::client_for_worktree(app, db, hosts, &worktree.id).await?;
            let display_path = format!("{}/{}", worktree.path, relative);
            let exists: bool = fs_rpc(
                &client,
                &FsRequest::PathExists {
                    root: worktree.path.clone(),
                    path: relative.clone(),
                },
            )?;
            if !exists {
                return Ok(starter_document(display_path));
            }
            let file: pragma_constants::FileContents = fs_rpc(
                &client,
                &FsRequest::ReadFile {
                    root: worktree.path,
                    path: relative.clone(),
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

/// Writes a scoped `.pragma` document and returns the client that owns it, so
/// callers can follow up with an RPC on the same host.
async fn write_scoped(
    handles: ScopeHandles<'_>,
    scope: ConfigScope,
    project_id: Option<String>,
    relative: String,
    contents: String,
) -> AppResult<PtyClient> {
    let ScopeHandles {
        app,
        db,
        hosts,
        pty,
    } = handles;
    match scope {
        ConfigScope::Global => {
            write_local(app.path().home_dir()?.join(relative.as_str()), contents).await?;
            Ok(pty.clone())
        }
        ConfigScope::Project => {
            let worktree = project_main_worktree(db, &require_project_id(project_id)?)?;
            let client = ssh_host::client_for_worktree(app, db, hosts, &worktree.id).await?;
            let parent_dir = std::path::Path::new(relative.as_str())
                .parent()
                .and_then(std::path::Path::to_str)
                .unwrap_or(".pragma")
                .to_string();
            let exists: bool = fs_rpc(
                &client,
                &FsRequest::PathExists {
                    root: worktree.path.clone(),
                    path: parent_dir.clone(),
                },
            )?;
            if !exists {
                fs_rpc::<()>(
                    &client,
                    &FsRequest::CreateFolder {
                        root: worktree.path.clone(),
                        path: parent_dir,
                    },
                )?;
            }
            fs_rpc::<()>(
                &client,
                &FsRequest::WriteFile {
                    root: worktree.path,
                    path: relative,
                    contents,
                },
            )?;
            Ok(client)
        }
    }
}

fn require_project_id(project_id: Option<String>) -> AppResult<String> {
    project_id.ok_or_else(|| AppError::InvalidInput("project scope requires projectId".to_string()))
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
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp_path = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temp_path)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(temp_path, path)?;
        Ok(())
    })
    .await
    .map_err(|error| AppError::InvalidInput(error.to_string()))?
}
