//! First-run onboarding state and the global skill install it offers.
//!
//! The tutorial itself lives in the frontend (`src/components/onboarding`); this
//! module owns the two persisted flags that keep it from returning, plus the one
//! side effect it has on disk: copying Pragma's bundled agent skill into a global
//! skill directory.

use std::path::Path;

use include_dir::{include_dir, Dir};
use pragma_constants::CONSTANTS;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};

const COMPLETED_KEY: &str = "onboarding.completed";
const TOUR_COMPLETED_KEY: &str = "onboarding.tourCompleted";

/// The `skills/pragma` tree, compiled into the binary.
///
/// Embedded rather than bundled as a Tauri resource so the same code path works
/// in `tauri dev`, in every installer format, and on all three platforms without
/// a staging script.
static PRAGMA_SKILL: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../../skills/pragma");

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingState {
    /// Whether the first-run tutorial finished or was skipped.
    completed: bool,
    /// Whether the in-workspace guided tour finished or was skipped.
    tour_completed: bool,
}

fn flag(db: &Db, key: &str) -> AppResult<bool> {
    Ok(db.setting(key)?.as_deref() == Some("true"))
}

/// Reads the persisted onboarding flags.
#[tauri::command]
pub fn onboarding_state(db: State<'_, Db>) -> AppResult<OnboardingState> {
    Ok(OnboardingState {
        completed: flag(&db, COMPLETED_KEY)?,
        tour_completed: flag(&db, TOUR_COMPLETED_KEY)?,
    })
}

/// Persists whether the first-run tutorial is finished.
#[tauri::command]
pub fn set_onboarding_completed(db: State<'_, Db>, completed: bool) -> AppResult<()> {
    db.set_setting(COMPLETED_KEY, if completed { "true" } else { "false" })
}

/// Persists whether the in-workspace guided tour is finished.
#[tauri::command]
pub fn set_onboarding_tour_completed(db: State<'_, Db>, completed: bool) -> AppResult<()> {
    db.set_setting(TOUR_COMPLETED_KEY, if completed { "true" } else { "false" })
}

/// Writes every embedded file of `dir` under `destination`, replacing what is there.
fn extract(dir: &Dir<'_>, destination: &Path) -> AppResult<()> {
    std::fs::create_dir_all(destination)?;
    for file in dir.files() {
        let name = file
            .path()
            .file_name()
            .ok_or_else(|| AppError::InvalidInput("skill file has no name".into()))?;
        std::fs::write(destination.join(name), file.contents())?;
    }
    for child in dir.dirs() {
        let name = child
            .path()
            .file_name()
            .ok_or_else(|| AppError::InvalidInput("skill directory has no name".into()))?;
        extract(child, &destination.join(name))?;
    }
    Ok(())
}

/// Installs the bundled Pragma skill into the named global skill directories.
///
/// `targets` are `onboarding.skill.targets[].id` values from `@pragma/constants`;
/// each resolves to a directory relative to the user's home. Returns the absolute
/// path written for each target, in the order given. Re-installing overwrites the
/// shipped files in place, so an existing install is upgraded rather than doubled.
#[tauri::command(async)]
pub fn install_pragma_skill(app: AppHandle, targets: Vec<String>) -> AppResult<Vec<String>> {
    let home = app.path().home_dir()?;
    let skill = &CONSTANTS.onboarding.skill;
    let mut installed = Vec::with_capacity(targets.len());
    for target in targets {
        let directory = skill
            .targets
            .iter()
            .find(|candidate| candidate.id == target)
            .ok_or_else(|| AppError::InvalidInput(format!("unknown skill target: {target}")))?
            .directory
            .as_str();
        let destination = home.join(directory).join(skill.id.as_str());
        extract(&PRAGMA_SKILL, &destination)?;
        installed.push(destination.to_string_lossy().into_owned());
    }
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_the_skill_and_its_references() {
        assert!(PRAGMA_SKILL.get_file("SKILL.md").is_some());
        assert!(PRAGMA_SKILL.get_dir("references").is_some());
    }

    #[test]
    fn extract_writes_nested_files() {
        let temp = std::env::temp_dir().join(format!("pragma-skill-{}", uuid::Uuid::new_v4()));
        extract(&PRAGMA_SKILL, &temp).expect("extract");
        assert!(temp.join("SKILL.md").is_file());
        assert!(temp.join("references").is_dir());
        // Re-extracting over an existing install must succeed, not fail on the
        // directories it already created.
        extract(&PRAGMA_SKILL, &temp).expect("re-extract");
        std::fs::remove_dir_all(&temp).ok();
    }
}
