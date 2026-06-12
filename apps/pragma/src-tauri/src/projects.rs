use std::path::PathBuf;

use pragma_constants::Project;

use crate::db::Db;
use crate::error::AppError;
use crate::git;

/// List all registered projects.
#[tauri::command]
pub fn list_projects(db: tauri::State<'_, Db>) -> Result<Vec<Project>, AppError> {
    db.list_projects()
}

/// Add a project from an existing directory.
#[tauri::command]
pub fn add_project(db: tauri::State<'_, Db>, path: String) -> Result<Project, AppError> {
    let path = PathBuf::from(&path);
    if !path.exists() {
        return Err(AppError::Invalid(format!(
            "path does not exist: {}",
            path.display()
        )));
    }
    if !git::is_repo(&path) {
        return Err(AppError::Invalid(
            "directory is not a git repository".into(),
        ));
    }

    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    if db.get_project_by_path(&path.to_string_lossy())?.is_some() {
        return Err(AppError::Invalid("project already added".into()));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let projects = db.list_projects()?;
    let order_index = projects.len() as i64;

    let project = db.add_project(&id, &name, &path.to_string_lossy(), order_index)?;

    git::ensure_pragma_excluded(&path)?;

    let worktree_id = uuid::Uuid::new_v4().to_string();
    db.add_worktree(
        &worktree_id,
        &project.id,
        None,
        &git::current_branch(&path)?,
        None,
        &path.to_string_lossy(),
        true,
    )?;

    if let Some(parent) = path.parent() {
        db.set_setting("projectsDirectory", &parent.to_string_lossy())?;
    }

    Ok(project)
}

/// Clone a remote repository and add it as a project.
#[tauri::command]
pub fn clone_project(
    db: tauri::State<'_, Db>,
    remote_url: String,
    into_directory: String,
) -> Result<Project, AppError> {
    let into_path = PathBuf::from(&into_directory);
    git::clone(&remote_url, &into_path)?;

    let name = into_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let id = uuid::Uuid::new_v4().to_string();
    let projects = db.list_projects()?;
    let order_index = projects.len() as i64;

    let project = db.add_project(&id, &name, &into_path.to_string_lossy(), order_index)?;

    git::ensure_pragma_excluded(&into_path)?;

    let worktree_id = uuid::Uuid::new_v4().to_string();
    db.add_worktree(
        &worktree_id,
        &project.id,
        None,
        &git::current_branch(&into_path)?,
        None,
        &into_path.to_string_lossy(),
        true,
    )?;

    if let Some(parent) = into_path.parent() {
        db.set_setting("projectsDirectory", &parent.to_string_lossy())?;
    }

    Ok(project)
}

/// Get the saved projects directory (default picker location).
#[tauri::command]
pub fn get_projects_directory(db: tauri::State<'_, Db>) -> Result<Option<String>, AppError> {
    db.get_setting("projectsDirectory")
}
