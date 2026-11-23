//! Global lifecycle scripts: the `scripts` block of `~/.pragma/config.json`.
//!
//! They apply to every project on a host, layered on each project's own
//! `.pragma/scripts.json`. They are read from the home directory of the host
//! that owns the project, not from the desktop's: the commands run on that
//! host, and `pragma-server` needs them with no desktop involved (a fanout
//! attempt, a worktree a phone created).
//!
//! The ordering rules live here too, so every caller layers the two sources
//! the same way. A script list runs its commands concurrently, which is why
//! the layers are returned as ordered *phases* rather than one concatenated
//! list: global setup must finish before the project's setup starts.

use std::path::{Path, PathBuf};

use pragma_constants::{ProjectScriptEvent, CONSTANTS};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{
    runscripts_from_value, string_array_from_value, validate_command_array, validate_runscripts,
    ProjectScripts, ScriptDefinition,
};
use crate::{CoreError, CoreResult};

/// Env var naming the lifecycle event a headless script runs for, such as
/// `worktree.setup` or `project.add`.
pub const SCRIPT_EVENT_ENV: &str = "PRAGMA_SCRIPT_EVENT";

/// The validated `scripts` block of a global `config.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GlobalScripts {
    #[serde(default)]
    pub worktree: GlobalWorktreeScripts,
    #[serde(default)]
    pub project: GlobalProjectScripts,
}

/// Worktree scripts run for every worktree in every project.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GlobalWorktreeScripts {
    #[serde(default)]
    pub setup: Vec<String>,
    #[serde(default)]
    pub teardown: Vec<String>,
    #[serde(rename = "runScripts", default)]
    pub run_scripts: std::collections::BTreeMap<String, ScriptDefinition>,
}

/// Project lifecycle scripts. Global-only: a repository's checked-in files
/// must never run code merely because the project was added or cloned.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GlobalProjectScripts {
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
    #[serde(default)]
    pub switch: Vec<String>,
}

impl GlobalProjectScripts {
    /// The commands configured for `event`.
    #[must_use]
    pub fn commands(&self, event: ProjectScriptEvent) -> &[String] {
        match event {
            ProjectScriptEvent::Add => &self.add,
            ProjectScriptEvent::Remove => &self.remove,
            ProjectScriptEvent::Switch => &self.switch,
        }
    }
}

/// A headless lifecycle event, as [`SCRIPT_EVENT_ENV`] names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptEvent {
    WorktreeSetup,
    WorktreeTeardown,
    Project(ProjectScriptEvent),
}

impl ScriptEvent {
    /// The value [`SCRIPT_EVENT_ENV`] carries for this event.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WorktreeSetup => "worktree.setup",
            Self::WorktreeTeardown => "worktree.teardown",
            Self::Project(ProjectScriptEvent::Add) => "project.add",
            Self::Project(ProjectScriptEvent::Remove) => "project.remove",
            Self::Project(ProjectScriptEvent::Switch) => "project.switch",
        }
    }

    /// The `(name, value)` env pair a script for this event receives.
    #[must_use]
    pub fn env(self) -> (String, String) {
        (SCRIPT_EVENT_ENV.to_string(), self.as_str().to_string())
    }
}

/// Where one phase of a worktree hook's commands came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptSource {
    Global,
    Project,
}

/// One sequential batch of a worktree hook. Its commands run concurrently;
/// the next phase starts only after this one succeeded.
#[derive(Debug, Clone, Copy)]
pub struct ScriptPhase<'a> {
    pub source: ScriptSource,
    pub commands: &'a [String],
}

impl ScriptPhase<'_> {
    /// How failures of this phase are labelled, e.g. "global setup".
    #[must_use]
    pub fn label(&self, hook: &str) -> String {
        match self.source {
            ScriptSource::Global => format!("global {hook}"),
            ScriptSource::Project => hook.to_string(),
        }
    }
}

impl GlobalScripts {
    /// The phases a new worktree's setup runs in: global first, so it can
    /// prepare the environment (trust a toolchain file, copy secrets) that the
    /// project's own commands then build in.
    #[must_use]
    pub fn setup_phases<'a>(&'a self, project: &'a ProjectScripts) -> [ScriptPhase<'a>; 2] {
        [
            ScriptPhase {
                source: ScriptSource::Global,
                commands: &self.worktree.setup,
            },
            ScriptPhase {
                source: ScriptSource::Project,
                commands: &project.setup,
            },
        ]
    }

    /// The phases a worktree's teardown runs in: the reverse of setup, so the
    /// project tears down its services before the global layer cleans up.
    #[must_use]
    pub fn teardown_phases<'a>(&'a self, project: &'a ProjectScripts) -> [ScriptPhase<'a>; 2] {
        [
            ScriptPhase {
                source: ScriptSource::Project,
                commands: &project.teardown,
            },
            ScriptPhase {
                source: ScriptSource::Global,
                commands: &self.worktree.teardown,
            },
        ]
    }
}

impl ProjectScripts {
    /// The run scripts a worktree's header offers: every global one, with the
    /// project's own script winning when both use a name. The project knows
    /// its own `run` better than a machine-wide default does.
    #[must_use]
    pub fn with_global_run_scripts(mut self, global: &GlobalScripts) -> Self {
        for (name, definition) in &global.worktree.run_scripts {
            self.run_scripts
                .entry(name.clone())
                .or_insert_with(|| definition.clone());
        }
        self
    }
}

/// The global `config.json` under `home`.
#[must_use]
pub fn global_config_path(home: &Path) -> PathBuf {
    home.join(CONSTANTS.plugins.config_file_name.as_str())
}

/// Reads this host's global scripts from `home`. A missing file means no
/// global scripts; one that exists but does not parse is an error, because the
/// user wrote something and it is not doing what they meant.
pub fn read_global_scripts(home: &Path) -> CoreResult<GlobalScripts> {
    let path = global_config_path(home);
    match std::fs::read_to_string(&path) {
        Ok(raw) => parse_global_config(&raw, &path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(GlobalScripts::default()),
        Err(error) => Err(CoreError::Operation(format!("{}: {error}", path.display()))),
    }
}

/// Parses the `scripts` block out of a whole global `config.json` body. The
/// file's other blocks belong to other settings and are not validated here.
/// `path` is used only in errors.
pub fn parse_global_config(raw: &str, path: &Path) -> CoreResult<GlobalScripts> {
    let value: Value = serde_json::from_str(raw).map_err(|error| {
        CoreError::InvalidPayload(format!("{} is not valid JSON: {error}", path.display()))
    })?;
    let object = value.as_object().ok_or_else(|| {
        CoreError::InvalidPayload(format!("{} must contain a JSON object", path.display()))
    })?;
    let Some(scripts) = object.get("scripts") else {
        return Ok(GlobalScripts::default());
    };
    let at = format!("{}: scripts", path.display());
    let scripts = expect_object(scripts, &at)?;
    reject_unknown_keys(scripts, &["worktree", "project"], &at)?;
    Ok(GlobalScripts {
        worktree: worktree_scripts(scripts.get("worktree"), &format!("{at}.worktree"))?,
        project: project_scripts(scripts.get("project"), &format!("{at}.project"))?,
    })
}

fn worktree_scripts(value: Option<&Value>, at: &str) -> CoreResult<GlobalWorktreeScripts> {
    let Some(value) = value else {
        return Ok(GlobalWorktreeScripts::default());
    };
    let object = expect_object(value, at)?;
    reject_unknown_keys(object, &["setup", "teardown", "runScripts"], at)?;
    validate_command_array(object.get("setup"), at, "setup")?;
    validate_command_array(object.get("teardown"), at, "teardown")?;
    validate_runscripts(object.get("runScripts"), at)?;
    Ok(GlobalWorktreeScripts {
        setup: string_array_from_value(object.get("setup"))?,
        teardown: string_array_from_value(object.get("teardown"))?,
        run_scripts: runscripts_from_value(object.get("runScripts"))?,
    })
}

fn project_scripts(value: Option<&Value>, at: &str) -> CoreResult<GlobalProjectScripts> {
    let Some(value) = value else {
        return Ok(GlobalProjectScripts::default());
    };
    let object = expect_object(value, at)?;
    reject_unknown_keys(object, &["add", "remove", "switch"], at)?;
    for key in ["add", "remove", "switch"] {
        validate_command_array(object.get(key), at, key)?;
    }
    Ok(GlobalProjectScripts {
        add: string_array_from_value(object.get("add"))?,
        remove: string_array_from_value(object.get("remove"))?,
        switch: string_array_from_value(object.get("switch"))?,
    })
}

fn expect_object<'a>(value: &'a Value, at: &str) -> CoreResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| CoreError::InvalidPayload(format!("{at} must be an object")))
}

fn reject_unknown_keys(object: &Map<String, Value>, allowed: &[&str], at: &str) -> CoreResult<()> {
    match object.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(key) => Err(CoreError::InvalidPayload(format!(
            "{at} has unknown key `{key}`"
        ))),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use pragma_constants::ProjectScriptEvent;

    use super::{parse_global_config, read_global_scripts, ScriptEvent, ScriptSource};
    use crate::scripts::parse_config;

    fn path() -> &'static Path {
        Path::new("/home/me/.pragma/config.json")
    }

    #[test]
    fn a_config_without_scripts_has_none() {
        let scripts = parse_global_config(r#"{"tunnel":{"enabled":true}}"#, path())
            .expect("other blocks are not this parser's business");

        assert_eq!(scripts.worktree.setup, [] as [String; 0]);
        assert_eq!(scripts.project.add, [] as [String; 0]);
    }

    #[test]
    fn parses_every_hook() {
        let scripts = parse_global_config(
            r#"{"scripts":{
                "worktree":{"setup":["mise trust"],"teardown":["docker compose down"],
                            "runScripts":{"git":{"command":["lazygit"],"icon":"lucide:git-branch"}}},
                "project":{"add":["a"],"remove":["r"],"switch":["s"]}}}"#,
            path(),
        )
        .expect("a valid block parses");

        assert_eq!(scripts.worktree.setup, ["mise trust"]);
        assert_eq!(scripts.worktree.teardown, ["docker compose down"]);
        assert_eq!(
            scripts.worktree.run_scripts["git"].icon.as_deref(),
            Some("lucide:git-branch")
        );
        assert_eq!(scripts.project.commands(ProjectScriptEvent::Add), ["a"]);
        assert_eq!(scripts.project.commands(ProjectScriptEvent::Remove), ["r"]);
        assert_eq!(scripts.project.commands(ProjectScriptEvent::Switch), ["s"]);
    }

    #[test]
    fn names_the_file_and_key_path_of_a_mistake() {
        let error = parse_global_config(r#"{"scripts":{"project":{"open":["x"]}}}"#, path())
            .expect_err("`open` is not a hook");

        let message = error.to_string();
        assert!(
            message.contains("config.json: scripts.project"),
            "{message}"
        );
        assert!(message.contains("`open`"), "{message}");
    }

    #[test]
    fn rejects_a_blank_command() {
        let error = parse_global_config(r#"{"scripts":{"worktree":{"setup":[" "]}}}"#, path())
            .expect_err("a blank command is a mistake");

        assert!(error.to_string().contains("scripts.worktree.setup[0]"));
    }

    #[test]
    fn setup_runs_global_first_and_teardown_runs_it_last() {
        let global = parse_global_config(
            r#"{"scripts":{"worktree":{"setup":["g-up"],"teardown":["g-down"]}}}"#,
            path(),
        )
        .expect("valid");
        let project = parse_config(
            r#"{"setup":["p-up"],"teardown":["p-down"]}"#,
            Path::new("/repo/.pragma/scripts.json"),
        )
        .expect("valid");

        let setup = global.setup_phases(&project);
        assert_eq!(setup[0].source, ScriptSource::Global);
        assert_eq!(setup[0].commands, ["g-up"]);
        assert_eq!(setup[1].commands, ["p-up"]);
        assert_eq!(setup[0].label("setup"), "global setup");
        assert_eq!(setup[1].label("setup"), "setup");

        let teardown = global.teardown_phases(&project);
        assert_eq!(teardown[0].commands, ["p-down"]);
        assert_eq!(teardown[1].commands, ["g-down"]);
    }

    #[test]
    fn a_project_run_script_wins_over_a_global_one_with_its_name() {
        let global = parse_global_config(
            r#"{"scripts":{"worktree":{"runScripts":{
                "run":{"command":["global run"]},"git":{"command":["lazygit"]}}}}}"#,
            path(),
        )
        .expect("valid");
        let project = parse_config(
            r#"{"runScripts":{"run":{"command":["bun dev"]}}}"#,
            Path::new("/repo/.pragma/scripts.json"),
        )
        .expect("valid");

        let merged = project.with_global_run_scripts(&global);

        assert_eq!(
            merged.run_scripts["run"].command,
            [serde_json::json!("bun dev")]
        );
        assert!(merged.run_scripts.contains_key("git"));
    }

    #[test]
    fn a_missing_file_is_no_scripts() {
        let home = tempfile::tempdir().expect("tempdir");

        let scripts = read_global_scripts(home.path()).expect("absent is not an error");

        assert_eq!(scripts.worktree.setup, [] as [String; 0]);
    }

    #[test]
    fn reads_the_file_under_home() {
        let home = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(home.path().join(".pragma")).expect("dir");
        std::fs::write(
            home.path().join(".pragma/config.json"),
            r#"{"scripts":{"project":{"add":["echo hi"]}}}"#,
        )
        .expect("write");

        let scripts = read_global_scripts(home.path()).expect("valid");

        assert_eq!(scripts.project.add, ["echo hi"]);
    }

    #[test]
    fn event_names_are_dotted_scope_and_hook() {
        assert_eq!(ScriptEvent::WorktreeSetup.as_str(), "worktree.setup");
        assert_eq!(
            ScriptEvent::Project(ProjectScriptEvent::Switch).as_str(),
            "project.switch"
        );
    }
}
