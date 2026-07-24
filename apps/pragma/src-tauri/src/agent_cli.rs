use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};
use crate::pty::{cargo_executable, sidecar_executable, workspace_root};

const PATH_WARNING_EVENT: &str = "pragma:agent-cli-path-warning";

/// Ensures this app channel's `pragma-cli` helper is installed.
pub fn ensure_installed(app: &AppHandle, data_dir: &Path, channel: &str) -> AppResult<()> {
    let home = app.path().home_dir()?;
    let bin_dir = install_bin_dir(&home, data_dir, channel);
    std::fs::create_dir_all(&bin_dir)?;
    let destination = bin_dir.join("pragma-cli");
    let source = agent_source()?;
    copy_if_changed(&source, &destination)?;
    if channel == "pragma" && !path_contains(&bin_dir) {
        let _ = app.emit(PATH_WARNING_EVENT, bin_dir.to_string_lossy().to_string());
    }
    Ok(())
}

fn install_bin_dir(home: &Path, data_dir: &Path, channel: &str) -> PathBuf {
    if channel == "pragma" {
        home.join(".local/bin")
    } else {
        data_dir.join("bin")
    }
}

fn agent_source() -> AppResult<PathBuf> {
    if cfg!(debug_assertions) {
        let status = Command::new(cargo_executable())
            .args(["build", "-p", "pragma-cli"])
            .current_dir(workspace_root())
            .stdin(Stdio::null())
            .status()?;
        if !status.success() {
            return Err(AppError::Daemon("failed to build pragma-cli".to_string()));
        }
        Ok(workspace_root().join("target/debug/pragma-cli"))
    } else {
        Ok(sidecar_executable("pragma-cli"))
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::install_bin_dir;

    #[test]
    fn cli_install_is_global_for_prod_and_instance_scoped_for_dev() {
        let home = Path::new("/home/test");
        let data = Path::new("/data/pragma-dev-abc");
        assert_eq!(
            install_bin_dir(home, data, "pragma"),
            Path::new("/home/test/.local/bin")
        );
        assert_eq!(
            install_bin_dir(home, data, "pragma-dev-abc"),
            Path::new("/data/pragma-dev-abc/bin")
        );
    }
}
