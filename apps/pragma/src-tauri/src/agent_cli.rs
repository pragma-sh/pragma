use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};
use crate::pty::{cargo_executable, sidecar_executable, workspace_root};

const PATH_WARNING_EVENT: &str = "pragma:agent-cli-path-warning";

/// Ensures the `pragma-agent` helper is available from `~/.local/bin`.
pub fn ensure_installed(app: &AppHandle) -> AppResult<()> {
    let home = app.path().home_dir()?;
    let bin_dir = home.join(".local/bin");
    std::fs::create_dir_all(&bin_dir)?;
    let destination = bin_dir.join("pragma-agent");
    let source = agent_source()?;
    copy_if_changed(&source, &destination)?;
    if !path_contains(&bin_dir) {
        let _ = app.emit(PATH_WARNING_EVENT, bin_dir.to_string_lossy().to_string());
    }
    Ok(())
}

fn agent_source() -> AppResult<PathBuf> {
    if cfg!(debug_assertions) {
        let status = Command::new(cargo_executable())
            .args(["build", "-p", "pragma-agent-cli"])
            .current_dir(workspace_root())
            .stdin(Stdio::null())
            .status()?;
        if !status.success() {
            return Err(AppError::Daemon(
                "failed to build pragma-agent CLI".to_string(),
            ));
        }
        Ok(workspace_root().join("target/debug/pragma-agent"))
    } else {
        Ok(sidecar_executable("pragma-agent"))
    }
}

fn copy_if_changed(source: &Path, destination: &Path) -> AppResult<()> {
    let source_bytes = std::fs::read(source)?;
    let needs_copy = std::fs::read(destination).map_or(true, |existing| existing != source_bytes);
    if needs_copy {
        std::fs::write(destination, source_bytes)?;
        set_executable(destination)?;
    }
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}

fn path_contains(dir: &Path) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|entry| entry == dir))
}
