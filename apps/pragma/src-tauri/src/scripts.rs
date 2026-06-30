use std::collections::VecDeque;
use std::fmt::Write as _;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pragma_constants::{Project, Worktree, CONSTANTS};
use serde_json::Value;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

const SCRIPT_CONFIG_PATH: &str = ".pragma/scripts.json";

/// Validated project script config returned to the frontend and used by
/// backend lifecycle hooks. `run` stays as JSON because the Rust side only
/// validates and echoes the frontend-owned split tree.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct LoadedProjectScripts {
    pub setup: Vec<String>,
    pub run: Vec<Value>,
    pub build: Vec<Value>,
    pub teardown: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadlessCommandResult {
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub status: Option<i32>,
    pub duration: Duration,
}

impl HeadlessCommandResult {
    fn succeeded(&self) -> bool {
        self.status == Some(0)
    }
}

#[tauri::command]
pub fn load_project_scripts(
    db: State<'_, Db>,
    project_id: String,
) -> AppResult<LoadedProjectScripts> {
    let project = db.project(&project_id)?;
    load_project_scripts_from_project_path(Path::new(&project.path))
}

pub fn load_project_scripts_from_project_path(
    project_path: &Path,
) -> AppResult<LoadedProjectScripts> {
    let path = project_path.join(SCRIPT_CONFIG_PATH);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(empty_config()),
        Err(error) => return Err(AppError::Io(error)),
    };
    let value: Value = serde_json::from_str(&raw).map_err(|error| {
        AppError::InvalidInput(format!("{} is not valid JSON: {error}", path.display()))
    })?;
    validate_config(&value, &path)?;
    config_from_value(&value)
}

pub fn run_headless_commands(
    project: &Project,
    worktree: &Worktree,
    kind: &str,
    commands: &[String],
) -> AppResult<Vec<HeadlessCommandResult>> {
    let limit =
        usize::try_from(CONSTANTS.scripts.max_concurrent_commands.get()).unwrap_or(usize::MAX);
    run_headless_commands_with_limit(project, worktree, kind, commands, limit)
}

/// Runs one headless command from a worktree and returns stdout/stderr/status
/// regardless of exit code. Used by `pragma-cli tab exec` so non-zero exits are
/// captured instead of converted into a Tauri command error.
pub fn run_headless_command(
    project: &Project,
    worktree: &Worktree,
    command: &str,
) -> HeadlessCommandResult {
    run_one_command(project, worktree, command)
}

fn run_headless_commands_with_limit(
    project: &Project,
    worktree: &Worktree,
    kind: &str,
    commands: &[String],
    limit: usize,
) -> AppResult<Vec<HeadlessCommandResult>> {
    if commands.is_empty() {
        return Ok(Vec::new());
    }
    let worker_count = worker_count(commands.len(), limit);
    let queue = Arc::new(Mutex::new(
        commands
            .iter()
            .cloned()
            .enumerate()
            .collect::<VecDeque<(usize, String)>>(),
    ));
    let mut handles = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        let queue = Arc::clone(&queue);
        let project = project.clone();
        let worktree = worktree.clone();
        handles.push(std::thread::spawn(move || {
            let mut results = Vec::new();
            loop {
                let next = queue
                    .lock()
                    .expect("script command queue not poisoned")
                    .pop_front();
                let Some((index, command)) = next else {
                    break;
                };
                results.push((index, run_one_command(&project, &worktree, &command)));
            }
            results
        }));
    }

    let mut indexed = vec![None; commands.len()];
    for handle in handles {
        let results = handle
            .join()
            .map_err(|_| AppError::Script(format!("{kind} script worker panicked")))?;
        for (index, result) in results {
            indexed[index] = Some(result);
        }
    }
    let results = indexed
        .into_iter()
        .map(|result| result.expect("every script command must produce a result"))
        .collect::<Vec<_>>();
    let failures = results
        .iter()
        .filter(|result| !result.succeeded())
        .cloned()
        .collect::<Vec<_>>();
    if failures.is_empty() {
        return Ok(results);
    }
    Err(AppError::Script(format_failures(kind, &failures)))
}

fn run_one_command(project: &Project, worktree: &Worktree, command: &str) -> HeadlessCommandResult {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let started = Instant::now();
    let output = Command::new(shell)
        .arg("-lc")
        .arg(command)
        .current_dir(&worktree.path)
        .env("PRAGMA_WORKTREE_PATH", &worktree.path)
        .env("PRAGMA_PROJECT_PATH", &project.path)
        .env("PRAGMA_WORKTREE_ID", &worktree.id)
        .output();
    let duration = started.elapsed();
    match output {
        Ok(output) => HeadlessCommandResult {
            command: command.to_string(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            status: output.status.code(),
            duration,
        },
        Err(error) => HeadlessCommandResult {
            command: command.to_string(),
            stdout: String::new(),
            stderr: format!("failed to spawn command: {error}"),
            status: None,
            duration,
        },
    }
}

fn worker_count(command_count: usize, limit: usize) -> usize {
    limit.max(1).min(command_count)
}

fn empty_config() -> LoadedProjectScripts {
    LoadedProjectScripts::default()
}

fn config_from_value(value: &Value) -> AppResult<LoadedProjectScripts> {
    let object = value.as_object().ok_or_else(|| {
        AppError::InvalidInput("project script config must contain a JSON object".to_string())
    })?;
    Ok(LoadedProjectScripts {
        setup: string_array_from_value(object.get("setup"))?,
        run: interactive_array_from_value(object.get("run"))?,
        build: interactive_array_from_value(object.get("build"))?,
        teardown: string_array_from_value(object.get("teardown"))?,
    })
}

fn interactive_array_from_value(value: Option<&Value>) -> AppResult<Vec<Value>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .cloned()
        .ok_or_else(|| AppError::InvalidInput("expected script command array".to_string()))
}

fn string_array_from_value(value: Option<&Value>) -> AppResult<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .ok_or_else(|| AppError::InvalidInput("expected script command array".to_string()))?
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .map(ToString::to_string)
                .ok_or_else(|| AppError::InvalidInput("expected script command string".to_string()))
        })
        .collect()
}

fn validate_config(value: &Value, path: &Path) -> AppResult<()> {
    let object = value.as_object().ok_or_else(|| {
        AppError::InvalidInput(format!("{} must contain a JSON object", path.display()))
    })?;
    for key in object.keys() {
        if !matches!(key.as_str(), "setup" | "run" | "build" | "teardown") {
            return Err(AppError::InvalidInput(format!(
                "{} has unknown key `{key}`",
                path.display()
            )));
        }
    }
    validate_command_array(object.get("setup"), path, "setup")?;
    validate_command_array(object.get("teardown"), path, "teardown")?;
    validate_interactive_script_array(object.get("run"), path, "run")?;
    validate_interactive_script_array(object.get("build"), path, "build")?;
    Ok(())
}

fn validate_interactive_script_array(
    value: Option<&Value>,
    path: &Path,
    field: &str,
) -> AppResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let entries = value.as_array().ok_or_else(|| {
        AppError::InvalidInput(format!("{}.{field} must be an array", path.display()))
    })?;
    for (index, entry) in entries.iter().enumerate() {
        validate_interactive_script_node(entry, path, &format!("{field}[{index}]"))?;
    }
    Ok(())
}

fn validate_command_array(value: Option<&Value>, path: &Path, field: &str) -> AppResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let commands = value.as_array().ok_or_else(|| {
        AppError::InvalidInput(format!("{}.{field} must be an array", path.display()))
    })?;
    for (index, command) in commands.iter().enumerate() {
        validate_command(command, path, &format!("{field}[{index}]"))?;
    }
    Ok(())
}

fn validate_interactive_script_node(value: &Value, path: &Path, field: &str) -> AppResult<()> {
    if value.is_string() {
        return validate_command(value, path, field);
    }
    let object = value.as_object().ok_or_else(|| {
        AppError::InvalidInput(format!(
            "{}.{field} must be a command string or split object",
            path.display()
        ))
    })?;
    let has_horizontal = object.contains_key("left") || object.contains_key("right");
    let has_vertical = object.contains_key("top") || object.contains_key("bottom");
    if has_horizontal == has_vertical {
        return Err(AppError::InvalidInput(format!(
            "{}.{field} must use exactly one split axis: left/right or top/bottom",
            path.display()
        )));
    }
    let expected = if has_horizontal {
        ["left", "right"]
    } else {
        ["top", "bottom"]
    };
    for key in object.keys() {
        if !expected.contains(&key.as_str()) {
            return Err(AppError::InvalidInput(format!(
                "{}.{field} has unknown key `{key}`",
                path.display()
            )));
        }
    }
    for key in expected {
        let child = object.get(key).ok_or_else(|| {
            AppError::InvalidInput(format!("{}.{field}.{key} is required", path.display()))
        })?;
        validate_interactive_script_node(child, path, &format!("{field}.{key}"))?;
    }
    Ok(())
}

fn validate_command(value: &Value, path: &Path, field: &str) -> AppResult<()> {
    let command = value.as_str().ok_or_else(|| {
        AppError::InvalidInput(format!(
            "{}.{field} must be a command string",
            path.display()
        ))
    })?;
    if command.trim().is_empty() {
        return Err(AppError::InvalidInput(format!(
            "{}.{field} must not be empty",
            path.display()
        )));
    }
    Ok(())
}

fn format_failures(kind: &str, failures: &[HeadlessCommandResult]) -> String {
    let mut message = format!("{kind} scripts failed:\n");
    for (index, failure) in failures.iter().enumerate() {
        writeln!(
            message,
            "{}. {} exited {}",
            index + 1,
            failure.command,
            exit_label(failure.status)
        )
        .expect("writing to String cannot fail");
    }
    for failure in failures {
        write!(
            message,
            "\nCommand: {}\nExit: {}\nDuration: {:.1}s\n\n--- stdout ---\n{}\n--- stderr ---\n{}\n",
            failure.command,
            exit_label(failure.status),
            failure.duration.as_secs_f64(),
            failure.stdout,
            failure.stderr
        )
        .expect("writing to String cannot fail");
    }
    message
}

fn exit_label(status: Option<i32>) -> String {
    status.map_or_else(
        || "terminated by signal".to_string(),
        |code| code.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(path: &Path) -> Project {
        Project {
            id: "project".to_string(),
            name: "Project".to_string(),
            path: path.to_string_lossy().into_owned(),
            order_index: 0,
            created_at: "now".to_string(),
        }
    }

    fn worktree(path: &Path) -> Worktree {
        Worktree {
            id: "worktree".to_string(),
            project_id: "project".to_string(),
            parent_id: None,
            branch: "feature".to_string(),
            title: None,
            path: path.to_string_lossy().into_owned(),
            is_main: false,
            hidden: false,
            created_at: "now".to_string(),
        }
    }

    fn write_scripts(root: &Path, contents: &str) {
        let pragma = root.join(".pragma");
        std::fs::create_dir_all(&pragma).expect("create .pragma");
        std::fs::write(pragma.join("scripts.json"), contents).expect("write scripts");
    }

    #[test]
    fn missing_config_is_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = load_project_scripts_from_project_path(dir.path()).expect("load scripts");
        assert!(config.setup.is_empty());
        assert!(config.run.is_empty());
        assert!(config.build.is_empty());
        assert!(config.teardown.is_empty());
    }

    #[test]
    fn accepts_top_level_build_string_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_scripts(
            dir.path(),
            r#"{
              "build": [
                "cargo build",
                { "left": "cargo build -p foo", "right": "cargo build -p bar" }
              ]
            }"#,
        );

        let config = load_project_scripts_from_project_path(dir.path()).expect("load scripts");

        assert_eq!(config.build.len(), 2);
        assert_eq!(config.build[0].as_str(), Some("cargo build"));
    }

    #[test]
    fn accepts_top_level_run_string_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_scripts(
            dir.path(),
            r#"{
              "run": [
                "npm test -- --runInBand",
                { "left": "npm run dev", "right": "npm run test:watch" }
              ]
            }"#,
        );

        let config = load_project_scripts_from_project_path(dir.path()).expect("load scripts");

        assert_eq!(config.run.len(), 2);
        assert_eq!(config.run[0].as_str(), Some("npm test -- --runInBand"));
    }

    #[test]
    fn rejects_invalid_run_split() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_scripts(dir.path(), r#"{ "run": [{ "left": "a", "top": "b" }] }"#);
        let error = load_project_scripts_from_project_path(dir.path()).expect_err("invalid split");
        assert!(error.to_string().contains("exactly one split axis"));
    }

    #[test]
    fn rejects_empty_commands() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_scripts(dir.path(), r#"{ "setup": [" "] }"#);
        let error = load_project_scripts_from_project_path(dir.path()).expect_err("empty command");
        assert!(error.to_string().contains("setup[0] must not be empty"));
    }

    #[test]
    fn headless_commands_receive_environment() {
        let dir = tempfile::tempdir().expect("tempdir");
        let project = project(dir.path());
        let worktree = worktree(dir.path());
        let results = run_headless_commands_with_limit(
            &project,
            &worktree,
            "setup",
            &["printf \"$PRAGMA_WORKTREE_ID:$PRAGMA_PROJECT_PATH:$PRAGMA_WORKTREE_PATH\"".into()],
            1,
        )
        .expect("run command");
        assert_eq!(
            results[0].stdout,
            format!("worktree:{}:{}", project.path, worktree.path)
        );
    }

    #[test]
    fn headless_command_failures_include_every_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let project = project(dir.path());
        let worktree = worktree(dir.path());
        let error = run_headless_commands_with_limit(
            &project,
            &worktree,
            "teardown",
            &[
                "printf one >&2; exit 3".into(),
                "printf two >&2; exit 4".into(),
            ],
            2,
        )
        .expect_err("commands fail");
        let message = error.to_string();
        assert!(message.contains("teardown scripts failed"));
        assert!(message.contains("exit 3"));
        assert!(message.contains("exit 4"));
        assert!(message.contains("one"));
        assert!(message.contains("two"));
    }

    #[test]
    fn worker_count_respects_limit() {
        assert_eq!(worker_count(4, 2), 2);
        assert_eq!(worker_count(4, 0), 1);
        assert_eq!(worker_count(2, 8), 2);
    }
}
