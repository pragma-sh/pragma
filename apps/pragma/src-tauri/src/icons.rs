use std::path::Path;

use base64::Engine;
use pragma_constants::ProjectIcon;

use crate::db::Db;
use crate::error::AppResult;

const DIRS: &[&str] = &["", "public", "static", "assets", "src", "src/assets", "app"];
const NAMES: &[&str] = &[
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "icon.svg",
    "icon.png",
];

pub fn project_icon(db: &Db, project_id: String) -> AppResult<Option<ProjectIcon>> {
    let project = db.project(&project_id)?;
    Ok(find_icon(Path::new(&project.path)))
}

fn find_icon(project_path: &Path) -> Option<ProjectIcon> {
    for dir in DIRS {
        for name in NAMES {
            let path = project_path.join(dir).join(name);
            if path.is_file() {
                let data = std::fs::read(&path).ok()?;
                return Some(ProjectIcon {
                    mime: mime_for(name).to_string(),
                    data_base64: base64::engine::general_purpose::STANDARD.encode(data),
                });
            }
        }
    }
    None
}

fn mime_for(name: &str) -> &'static str {
    let extension = Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str());
    if extension.is_some_and(|extension| extension.eq_ignore_ascii_case("svg")) {
        "image/svg+xml"
    } else if extension.is_some_and(|extension| extension.eq_ignore_ascii_case("ico")) {
        "image/x-icon"
    } else {
        "image/png"
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::find_icon;

    #[test]
    fn detects_project_icon() {
        let dir = tempdir().expect("tempdir");
        std::fs::create_dir(dir.path().join("public")).expect("dir");
        std::fs::write(dir.path().join("public/favicon.svg"), "<svg />").expect("icon");
        let icon = find_icon(dir.path()).expect("icon should be found");
        assert_eq!(icon.mime, "image/svg+xml");
    }
}
