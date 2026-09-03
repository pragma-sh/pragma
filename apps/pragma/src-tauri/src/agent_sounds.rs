//! Alert clips played when an agent reports `done` or `attention`.
//!
//! Clips live in a scope's sounds directory (`.pragma/assets/sounds`): under the
//! home directory for global sounds and under the project's main worktree for
//! project sounds. Global scope touches the local disk directly; project scope
//! goes through the owning host's filesystem RPC, so an SSH-bridged project keeps
//! working. Clip bytes cross IPC as base64 rather than through the asset protocol
//! because a project's directory may live on another machine entirely.

use base64::Engine;
use pragma_constants::{AgentSound, AgentSoundList, SettingsScope, CONSTANTS};
use tauri::path::BaseDirectory;
use tauri::{Manager, State};

use pragma_core::fs::FsRequest;

use crate::config_file::ConfigScope;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::fs::fs_rpc;
use crate::hosts::Hosts;
use crate::pty::PtyClient;
use crate::ssh_host;

/// Rejects anything that is not a bare file name, so a clip reference from the
/// config file can never address a path outside the sounds directory.
fn sound_relative_path(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.starts_with('.')
    {
        return Err(AppError::InvalidInput(format!(
            "{name} is not a valid sound file name"
        )));
    }
    if !CONSTANTS
        .agent_status
        .sound_extensions
        .iter()
        .any(|extension| {
            std::path::Path::new(trimmed)
                .extension()
                .is_some_and(|found| found.to_string_lossy().to_lowercase() == *extension)
        })
    {
        return Err(AppError::InvalidInput(format!(
            "{name} is not a supported audio file"
        )));
    }
    Ok(format!(
        "{}/{trimmed}",
        CONSTANTS.agent_status.sounds_dir_name
    ))
}

/// Resource directory holding the clips shipped with the app.
const BUNDLED_SOUNDS_DIR: &str = "sounds";

/// Copies the bundled clips into the global sounds directory the first time it is
/// missing, so a fresh install has alert sounds to pick from without the user
/// supplying audio of their own.
///
/// Seeding is skipped whenever the directory already exists, so a clip the user
/// deleted stays deleted and an edited clip is never overwritten by an update.
pub fn seed_bundled_sounds(app: &tauri::AppHandle, home: &std::path::Path) -> AppResult<()> {
    let target = home.join(CONSTANTS.agent_status.sounds_dir_name.as_str());
    if target.exists() {
        return Ok(());
    }
    let source = app
        .path()
        .resolve(BUNDLED_SOUNDS_DIR, BaseDirectory::Resource)?;
    let entries = match std::fs::read_dir(&source) {
        Ok(entries) => entries,
        // A dev build run straight from cargo has no resource directory; that is
        // not an error worth failing startup over.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    std::fs::create_dir_all(&target)?;
    for entry in entries {
        let path = entry?.path();
        let Some(name) = path.file_name() else {
            continue;
        };
        // Only real clips travel: the directory also ships a credits file.
        if sound_relative_path(&name.to_string_lossy()).is_err() {
            continue;
        }
        std::fs::copy(&path, target.join(name))?;
    }
    Ok(())
}

fn scope_name(scope: ConfigScope) -> SettingsScope {
    match scope {
        ConfigScope::Global => SettingsScope::Global,
        ConfigScope::Project => SettingsScope::Project,
    }
}

/// Resolves the absolute root a scope's relative asset paths hang off, plus the
/// host client to reach it through (none for the local home directory).
async fn scope_root(
    app: tauri::AppHandle,
    db: &Db,
    hosts: &Hosts,
    scope: ConfigScope,
    project_id: Option<String>,
) -> AppResult<(String, Option<PtyClient>)> {
    match scope {
        ConfigScope::Global => Ok((app.path().home_dir()?.to_string_lossy().into_owned(), None)),
        ConfigScope::Project => {
            let worktree = crate::config_file::scoped_project_worktree(db, project_id)?;
            let client = ssh_host::client_for_worktree(app, db, hosts, &worktree.id).await?;
            Ok((worktree.path, Some(client)))
        }
    }
}

/// Lists the clips available in one scope, plus the directory Settings shows.
#[tauri::command]
pub async fn list_agent_sounds(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    scope: ConfigScope,
    project_id: Option<String>,
) -> AppResult<AgentSoundList> {
    let (root, client) = scope_root(app, &db, &hosts, scope, project_id).await?;
    let relative = CONSTANTS.agent_status.sounds_dir_name.clone();
    let dir = format!("{root}/{relative}");
    let extensions = CONSTANTS.agent_status.sound_extensions.clone();
    let names: Vec<String> = match client {
        Some(client) => fs_rpc(
            &client,
            &FsRequest::ListFileNames {
                root,
                path: relative,
                extensions,
            },
        )?,
        None => tauri::async_runtime::spawn_blocking(move || {
            pragma_core::fs::list_file_names(&root, &relative, &extensions)
                .map_err(|error| AppError::InvalidInput(error.to_string()))
        })
        .await
        .map_err(|error| AppError::InvalidInput(error.to_string()))??,
    };
    Ok(AgentSoundList {
        dir,
        sounds: names
            .into_iter()
            .map(|name| AgentSound {
                name,
                scope: scope_name(scope),
            })
            .collect(),
    })
}

/// Returns one clip's bytes as base64 so the webview can play it.
#[tauri::command]
pub async fn read_agent_sound(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    scope: ConfigScope,
    project_id: Option<String>,
    name: String,
) -> AppResult<String> {
    let relative = sound_relative_path(&name)?;
    let (root, client) = scope_root(app, &db, &hosts, scope, project_id).await?;
    match client {
        Some(client) => fs_rpc(
            &client,
            &FsRequest::ReadBytes {
                root,
                path: relative,
            },
        ),
        None => tauri::async_runtime::spawn_blocking(move || {
            pragma_core::fs::read_bytes(&root, &relative)
                .map_err(|error| AppError::InvalidInput(error.to_string()))
        })
        .await
        .map_err(|error| AppError::InvalidInput(error.to_string()))?,
    }
}

/// Stores an uploaded clip in a scope's sounds directory, creating the directory
/// on first use. The frontend enforces the duration limit before calling, since
/// only the webview can decode audio.
#[tauri::command]
pub async fn import_agent_sound(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    scope: ConfigScope,
    project_id: Option<String>,
    name: String,
    contents_base64: String,
) -> AppResult<AgentSound> {
    let relative = sound_relative_path(&name)?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(contents_base64.as_bytes())
        .map_err(|error| AppError::InvalidInput(format!("invalid audio upload: {error}")))?;
    let max_bytes = CONSTANTS.agent_status.max_sound_bytes.get();
    if decoded.len() as u64 > max_bytes {
        return Err(AppError::InvalidInput(format!(
            "audio clips must be {max_bytes} bytes or smaller"
        )));
    }
    let (root, client) = scope_root(app, &db, &hosts, scope, project_id).await?;
    match client {
        Some(client) => {
            crate::config_file::ensure_host_dir(
                &client,
                &root,
                CONSTANTS.agent_status.sounds_dir_name.as_str(),
            )?;
            fs_rpc::<()>(
                &client,
                &FsRequest::WriteBytes {
                    root,
                    path: relative,
                    contents: contents_base64,
                },
            )?;
        }
        None => {
            tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
                let target = std::path::Path::new(&root).join(&relative);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(target, decoded)?;
                Ok(())
            })
            .await
            .map_err(|error| AppError::InvalidInput(error.to_string()))??;
        }
    }
    Ok(AgentSound {
        name: name.trim().to_string(),
        scope: scope_name(scope),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_bare_file_names() {
        assert_eq!(
            sound_relative_path("Chime.WAV").unwrap(),
            format!("{}/Chime.WAV", CONSTANTS.agent_status.sounds_dir_name)
        );
        assert_eq!(
            sound_relative_path("  alert.mp3 ").unwrap(),
            format!("{}/alert.mp3", CONSTANTS.agent_status.sounds_dir_name)
        );
    }

    /// Every shipped clip has to survive `sound_relative_path`, or seeding would
    /// silently skip it and a fresh install would come up with no sounds at all.
    #[test]
    fn bundled_clips_are_playable_names() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(BUNDLED_SOUNDS_DIR);
        let mut clips = 0;
        for entry in std::fs::read_dir(&dir).expect("bundled sounds directory") {
            let path = entry.expect("directory entry").path();
            let name = path
                .file_name()
                .expect("file name")
                .to_string_lossy()
                .into_owned();
            if name == "CREDITS.md" {
                continue;
            }
            sound_relative_path(&name).unwrap_or_else(|_| panic!("{name} is not a playable clip"));
            clips += 1;
        }
        assert!(clips > 0, "no clips are bundled");
    }

    #[test]
    fn rejects_paths_and_unsupported_extensions() {
        for name in [
            "",
            "   ",
            "../escape.mp3",
            "nested/clip.mp3",
            "nested\\clip.mp3",
            ".hidden.mp3",
            "notes.txt",
            "noextension",
        ] {
            assert!(
                sound_relative_path(name).is_err(),
                "expected {name} to be rejected"
            );
        }
    }
}
