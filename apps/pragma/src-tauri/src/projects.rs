use std::path::{Path, PathBuf};

use pragma_constants::Project;
use tauri::{Manager, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::git;

const PROJECTS_DIRECTORY: &str = "projectsDirectory";

/// Lists projects. A plain (non-git) project whose folder has since become a
/// repository — the user ran `git init` in a terminal — is promoted on the way.
#[tauri::command(async)]
pub fn list_projects(
    db: State<'_, Db>,
    publisher: State<'_, crate::workspace_mirror::WorkspacePublisher>,
) -> AppResult<Vec<Project>> {
    let projects = db.list_projects()?;
    let mut promoted = false;
    for project in projects.iter().filter(|project| !project.is_git) {
        promoted |= promote_if_repository(&db, project)?;
    }
    if !promoted {
        return Ok(projects);
    }
    publisher.trigger();
    db.list_projects()
}

/// Whether `path` is the root of a git repository — what the Add project flow
/// asks before deciding whether to warn about a plain folder.
#[tauri::command(async)]
pub fn project_directory_is_git(path: String) -> AppResult<bool> {
    git::is_repo_root(&pragma_platform::path::canonicalize(PathBuf::from(path))?)
}

/// Adds a local folder as a project. A folder that is not a git repository is
/// refused unless `allow_non_git` is set, in which case it becomes a plain
/// project: one root worktree, no git features.
#[tauri::command(async)]
pub fn add_project(
    db: State<'_, Db>,
    publisher: State<'_, crate::workspace_mirror::WorkspacePublisher>,
    path: String,
    allow_non_git: Option<bool>,
) -> AppResult<Project> {
    let project = add_project_path(&db, PathBuf::from(path), allow_non_git.unwrap_or(false))?;
    publisher.trigger();
    Ok(project)
}

/// Initializes a git repository in a plain project's folder and promotes the
/// project in place, so its tabs, agent sessions and statuses carry over.
#[tauri::command(async)]
pub fn init_project_git(
    db: State<'_, Db>,
    publisher: State<'_, crate::workspace_mirror::WorkspacePublisher>,
    project_id: String,
) -> AppResult<Project> {
    let project = db.project(&project_id)?;
    if !project.is_git {
        let path = Path::new(&project.path);
        if !git::is_repo_root(path)? {
            git::init_repository(path)?;
        }
        promote_if_repository(&db, &project)?;
        publisher.trigger();
    }
    db.project(&project_id)
}

#[tauri::command]
pub fn remove_project(
    db: State<'_, Db>,
    publisher: State<'_, crate::workspace_mirror::WorkspacePublisher>,
    project_id: String,
) -> AppResult<()> {
    db.delete_project(&project_id)?;
    publisher.trigger();
    Ok(())
}

/// Sets the emoji a project shows in the project switcher. An empty or blank
/// `emoji` clears the override, falling the switcher back to a favicon found in
/// the checkout and then to the project name's initial.
#[tauri::command]
pub fn set_project_icon(
    db: State<'_, Db>,
    publisher: State<'_, crate::workspace_mirror::WorkspacePublisher>,
    project_id: String,
    emoji: Option<String>,
) -> AppResult<Project> {
    let emoji = emoji.map(|emoji| emoji.trim().to_string());
    let emoji = emoji.filter(|emoji| !emoji.is_empty());
    db.set_project_icon_emoji(&project_id, emoji.as_deref())?;
    publisher.trigger();
    db.project(&project_id)
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
    let project = add_project_path(&db, target, false)?;
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

fn add_project_path(db: &Db, path: PathBuf, allow_non_git: bool) -> AppResult<Project> {
    // This string is stored and later handed to git as a worktree location, so
    // it has to be canonical *and* plain — `std`'s canonicalize would hand
    // Windows back a `\\?\C:\…` verbatim path that git reads as a UNC path.
    let canonical = pragma_platform::path::canonicalize(&path)?;
    let is_git = !allow_non_git || git::is_repo_root(&canonical)?;
    if is_git {
        git::ensure_repo(&canonical)?;
        git::ensure_pragma_excluded(&canonical)?;
    }
    let name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidInput("project path has no directory name".to_string()))?
        .to_string();
    if let Some(parent) = canonical.parent() {
        db.set_setting(PROJECTS_DIRECTORY, &parent.to_string_lossy())?;
    }
    let stored_path = canonical.to_string_lossy().into_owned();
    if !is_git {
        return db.insert_plain_project(name, stored_path);
    }
    let branch = git::current_branch(&canonical)?;
    db.insert_project_with_main_worktree(name, stored_path, branch)
}

/// Promotes a plain project whose folder is now a git repository root.
/// Returns whether it did. Plain projects are always local — a remote project
/// must already be a repository to be added — so the folder is on this disk.
fn promote_if_repository(db: &Db, project: &Project) -> AppResult<bool> {
    let path = Path::new(&project.path);
    // A cheap stat first: this runs on every project list, and a plain folder
    // almost never has a `.git`, so git is only asked on a real transition.
    if !path.join(".git").exists() || !git::is_repo_root(path)? {
        return Ok(false);
    }
    git::ensure_pragma_excluded(path)?;
    db.mark_project_git(&project.id, &git::current_branch(path)?)?;
    Ok(true)
}
