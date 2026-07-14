//! Global/project `.pragma/config.json` access for Settings controls.

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
    scope: ConfigScope,
    project_id: Option<String>,
) -> AppResult<ConfigDocument> {
    match scope {
        ConfigScope::Global => {
            let path = app
                .path()
                .home_dir()?
                .join(CONSTANTS.plugins.config_file_name.as_str());
            read_local(path).await
        }
        ConfigScope::Project => {
            let project_id = project_id.ok_or_else(|| {
                AppError::InvalidInput("project scope requires projectId".to_string())
            })?;
            let worktree = project_main_worktree(&db, &project_id)?;
            let client = ssh_host::client_for_worktree(app, &db, &hosts, &worktree.id).await?;
            let relative = CONSTANTS.plugins.config_file_name.clone();
            let exists: bool = fs_rpc(
                &client,
                &FsRequest::PathExists {
                    root: worktree.path.clone(),
                    path: relative.clone(),
                },
            )?;
            let display_path = format!("{}/{}", worktree.path, relative);
            if !exists {
                return Ok(starter_document(display_path));
            }
            let file: pragma_constants::FileContents = fs_rpc(
                &client,
                &FsRequest::ReadFile {
                    root: worktree.path,
                    path: relative,
                },
            )?;
            if file.binary || file.truncated {
                return Err(AppError::InvalidInput(
                    "config.json must be a small UTF-8 text file".to_string(),
                ));
            }
            Ok(ConfigDocument {
                exists: true,
                contents: file.text,
                path: display_path,
            })
        }
    }
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
    match scope {
        ConfigScope::Global => {
            let path = app
                .path()
                .home_dir()?
                .join(CONSTANTS.plugins.config_file_name.as_str());
            write_local(path, contents).await?;
            if let Err(error) = reload_plugins(&pty) {
                log::warn!("config saved but plugin reload failed: {error}");
            }
            Ok(())
        }
        ConfigScope::Project => {
            let project_id = project_id.ok_or_else(|| {
                AppError::InvalidInput("project scope requires projectId".to_string())
            })?;
            let worktree = project_main_worktree(&db, &project_id)?;
            let client = ssh_host::client_for_worktree(app, &db, &hosts, &worktree.id).await?;
            let config_dir = std::path::Path::new(CONSTANTS.plugins.config_file_name.as_str())
                .parent()
                .and_then(std::path::Path::to_str)
                .unwrap_or(".pragma")
                .to_string();
            let exists: bool = fs_rpc(
                &client,
                &FsRequest::PathExists {
                    root: worktree.path.clone(),
                    path: config_dir.clone(),
                },
            )?;
            if !exists {
                fs_rpc::<()>(
                    &client,
                    &FsRequest::CreateFolder {
                        root: worktree.path.clone(),
                        path: config_dir,
                    },
                )?;
            }
            fs_rpc::<()>(
                &client,
                &FsRequest::WriteFile {
                    root: worktree.path,
                    path: CONSTANTS.plugins.config_file_name.clone(),
                    contents,
                },
            )?;
            if let Err(error) = reload_plugins(&client) {
                log::warn!("project config saved but plugin reload failed: {error}");
            }
            Ok(())
        }
    }
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
