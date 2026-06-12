use std::path::PathBuf;

use base64::Engine;
use pragma_constants::ProjectIcon;

use crate::db::Db;
use crate::error::AppError;

const FAVICON_DIRS: &[&str] = &["", "public", "static", "assets", "src", "src/assets", "app"];
const FAVICON_NAMES: &[&str] = &[
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "icon.svg",
    "icon.png",
];

/// Get the project icon (favicon) as a base64-encoded string.
#[tauri::command]
pub fn project_icon(
    db: tauri::State<'_, Db>,
    project_id: String,
) -> Result<Option<ProjectIcon>, AppError> {
    let project = db
        .get_project(&project_id)?
        .ok_or_else(|| AppError::NotFound("project not found".into()))?;

    let project_path = PathBuf::from(&project.path);

    for dir in FAVICON_DIRS {
        let search_dir = if dir.is_empty() {
            project_path.clone()
        } else {
            project_path.join(dir)
        };

        for name in FAVICON_NAMES {
            let candidate = search_dir.join(name);
            if candidate.exists() {
                let data = std::fs::read(&candidate)?;
                let mime = mime_from_path(name);
                let data_base64 = base64::engine::general_purpose::STANDARD.encode(&data);
                return Ok(Some(ProjectIcon {
                    mime: mime.to_string(),
                    data_base64,
                }));
            }
        }
    }

    Ok(None)
}

fn mime_from_path(name: &str) -> &'static str {
    if name.ends_with(".svg") {
        "image/svg+xml"
    } else if name.ends_with(".ico") {
        "image/x-icon"
    } else if name.ends_with(".png") {
        "image/png"
    } else {
        "application/octet-stream"
    }
}
