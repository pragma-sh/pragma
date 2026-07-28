use std::path::{Path, PathBuf};
use std::process::Stdio;

use pragma_constants::{EditorLauncher, CONSTANTS};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// Opens a worktree in the requested editor, or the system file explorer by default.
///
/// The absolute path is looked up from the DB by `worktree_id` (never trusted
/// from the frontend), keeping this consistent with the worktree-scoped `fs`/`git`
/// commands: the IPC surface can only launch an editor on a known worktree, not an
/// arbitrary directory.
#[tauri::command(async)]
pub fn open_worktree(
    db: State<'_, Db>,
    worktree_id: String,
    editor_id: Option<String>,
) -> AppResult<()> {
    let worktree_path = PathBuf::from(db.worktree(&worktree_id)?.path);
    if !worktree_path.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "worktree path does not exist: {}",
            worktree_path.display()
        )));
    }

    match cli_command_for(editor_id.as_deref())? {
        Some(cli_command) => spawn_editor(cli_command, &worktree_path),
        None => opener::open(&worktree_path)
            .map_err(|error| AppError::InvalidInput(format!("failed to open worktree: {error}"))),
    }
}

fn cli_command_for(editor_id: Option<&str>) -> AppResult<Option<&'static str>> {
    let target_id = editor_id.unwrap_or(CONSTANTS.editor_launchers.default_editor_id.as_str());
    let editor = editor_for(target_id)
        .ok_or_else(|| AppError::InvalidInput(format!("unknown editor launcher: {target_id}")))?;
    Ok(editor.cli_command.as_deref())
}

fn editor_for(editor_id: &str) -> Option<&'static EditorLauncher> {
    CONSTANTS
        .editor_launchers
        .options
        .iter()
        .find(|editor| editor.id.as_str() == editor_id)
}

fn spawn_editor(cli_command: &str, worktree_path: &Path) -> AppResult<()> {
    crate::process_env::command(cli_command)
        .arg(worktree_path)
        .current_dir(worktree_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| AppError::InvalidInput(format!("failed to launch {cli_command}: {error}")))
}

#[cfg(test)]
mod tests {
    use super::cli_command_for;

    #[test]
    fn default_launcher_uses_system_file_explorer() {
        assert_eq!(cli_command_for(None).unwrap(), None);
    }

    #[test]
    fn known_editor_returns_cli_command() {
        assert_eq!(cli_command_for(Some("vscode")).unwrap(), Some("code"));
    }

    #[test]
    fn unknown_editor_is_rejected() {
        assert!(cli_command_for(Some("definitely-not-an-editor")).is_err());
    }
}
