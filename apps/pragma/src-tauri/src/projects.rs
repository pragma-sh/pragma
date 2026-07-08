use std::path::PathBuf;

use pragma_constants::Project;
use tauri::{Manager, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::git;

const PROJECTS_DIRECTORY: &str = "projectsDirectory";

#[tauri::command]
pub fn list_projects(db: State<'_, Db>) -> AppResult<Vec<Project>> {
    db.list_projects()
}

#[tauri::command(async)]
pub fn add_project(
    db: State<'_, Db>,
    publisher: State<'_, crate::workspace_mirror::WorkspacePublisher>,
    path: String,
) -> AppResult<Project> {
    let project = add_project_path(&db, PathBuf::from(path))?;
    publisher.trigger();
    Ok(project)
}

#[tauri::command(async)]
pub fn clone_project(
    db: State<'_, Db>,
    publisher: State<'_, crate::workspace_mirror::WorkspacePublisher>,
    remote_url: String,
    into_directory: String,
) -> AppResult<Project> {
    let target = git::clone(&remote_url, &PathBuf::from(&into_directory))?;
    db.set_setting(PROJECTS_DIRECTORY, &into_directory)?;
    let project = add_project_path(&db, target)?;
    publisher.trigger();
    Ok(project)
}

#[tauri::command]
pub fn get_projects_directory(app: tauri::AppHandle, db: State<'_, Db>) -> AppResult<String> {
    if let Some(path) = db.setting(PROJECTS_DIRECTORY)? {
        return Ok(path);
    }
    Ok(app.path().home_dir()?.to_string_lossy().into_owned())
}

fn add_project_path(db: &Db, path: PathBuf) -> AppResult<Project> {
    let canonical = path.canonicalize()?;
    git::ensure_repo(&canonical)?;
    git::ensure_pragma_excluded(&canonical)?;
    let branch = git::current_branch(&canonical)?;
    let name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidInput("project path has no directory name".to_string()))?
        .to_string();
    if let Some(parent) = canonical.parent() {
        db.set_setting(PROJECTS_DIRECTORY, &parent.to_string_lossy())?;
    }
    db.insert_project_with_main_worktree(name, canonical.to_string_lossy().into_owned(), branch)
}
