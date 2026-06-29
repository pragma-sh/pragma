use std::fmt::Write as _;
use std::path::Path;
use std::time::Duration;

use pragma_constants::{FileContents, Project, ProtocolRpcMethod, Worktree, CONSTANTS};
use pragma_core::exec::{CommandResult, ExecRequest};
use pragma_core::fs::FsRequest;
use serde_json::Value;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::hosts::Hosts;
use crate::pty::PtyClient;

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

/// Loads a project's `.pragma/scripts.json` from its host (local or remote).
#[tauri::command]
pub fn load_project_scripts(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    project_id: String,
) -> AppResult<LoadedProjectScripts> {
    let project = db.project(&project_id)?;
    let pty = hosts.for_project(&db, &project_id)?;
    load_project_scripts_on_host(&pty, &project.path)
}

/// Reads + validates `.pragma/scripts.json` on `pty`'s host. A missing or
/// unreadable file yields an empty config; malformed JSON surfaces as an error.
pub fn load_project_scripts_on_host(
    pty: &PtyClient,
    project_root: &str,
) -> AppResult<LoadedProjectScripts> {
    let config_path = Path::new(project_root).join(SCRIPT_CONFIG_PATH);
    match read_scripts_json(pty, project_root) {
        Some(raw) => parse_config(&raw, &config_path),
        None => Ok(LoadedProjectScripts::default()),
    }
}

/// Reads `.pragma/scripts.json` via the host's `filesystem` RPC, returning its
/// text or `None` when it is absent, unreadable, binary, or truncated.
fn read_scripts_json(pty: &PtyClient, project_root: &str) -> Option<String> {
    let request = FsRequest::ReadFile {
        root: project_root.to_string(),
        path: SCRIPT_CONFIG_PATH.to_string(),
    };
    let payload = serde_json::to_value(request).ok()?;
    let value = pty.rpc(ProtocolRpcMethod::Filesystem, payload).ok()?;
    let contents: FileContents = serde_json::from_value(value).ok()?;
    if contents.binary || contents.truncated {
        return None;
    }
    Some(contents.text)
}

/// Validates and parses a `scripts.json` body. `path` is used only for error
/// messages.
fn parse_config(raw: &str, path: &Path) -> AppResult<LoadedProjectScripts> {
    let value: Value = serde_json::from_str(raw).map_err(|error| {
        AppError::InvalidInput(format!("{} is not valid JSON: {error}", path.display()))
    })?;
    validate_config(&value, path)?;
    config_from_value(&value)
}

/// Runs a project's `setup`/`teardown` commands on the worktree's host and
/// returns each command's result, erroring if any command failed.
pub fn run_headless_commands(
    pty: &PtyClient,
    project: &Project,
    worktree: &Worktree,
    kind: &str,
    commands: &[String],
) -> AppResult<Vec<HeadlessCommandResult>> {
    if commands.is_empty() {
        return Ok(Vec::new());
    }
    let request = ExecRequest {
        cwd: worktree.path.clone(),
        commands: commands.to_vec(),
        env: vec![
            ("PRAGMA_WORKTREE_PATH".to_string(), worktree.path.clone()),
            ("PRAGMA_PROJECT_PATH".to_string(), project.path.clone()),
            ("PRAGMA_WORKTREE_ID".to_string(), worktree.id.clone()),
        ],
        max_concurrent: u32::try_from(CONSTANTS.scripts.max_concurrent_commands.get()).map_err(
            |_| AppError::InvalidInput("script concurrency limit is too large".to_string()),
        )?,
    };
    let payload = serde_json::to_value(request)?;
    let value = pty.rpc(ProtocolRpcMethod::Exec, payload)?;
    let results: Vec<CommandResult> = serde_json::from_value(value)?;
    let results: Vec<HeadlessCommandResult> = results
        .into_iter()
        .map(|result| HeadlessCommandResult {
            command: result.command,
            stdout: result.stdout,
            stderr: result.stderr,
            status: result.status,
            duration: Duration::from_millis(result.duration_ms),
        })
        .collect();
    let failures = results
        .iter()
        .filter(|result| !result.succeeded())
        .cloned()
        .collect::<Vec<_>>();
    if failures.is_empty() {
        Ok(results)
    } else {
        Err(AppError::Script(format_failures(kind, &failures)))
    }
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
    use std::path::Path;

    use super::parse_config;

    fn parse(raw: &str) -> super::AppResult<super::LoadedProjectScripts> {
        parse_config(raw, Path::new("/p/.pragma/scripts.json"))
    }

    #[test]
    fn empty_object_is_empty_config() {
        let config = parse("{}").expect("parse");
        assert!(config.setup.is_empty());
        assert!(config.run.is_empty());
        assert!(config.build.is_empty());
        assert!(config.teardown.is_empty());
    }

    #[test]
    fn accepts_top_level_build_string_entries() {
        let config = parse(
            r#"{ "build": ["cargo build", { "left": "cargo build -p foo", "right": "cargo build -p bar" }] }"#,
        )
        .expect("parse");
        assert_eq!(config.build.len(), 2);
        assert_eq!(config.build[0].as_str(), Some("cargo build"));
    }

    #[test]
    fn accepts_top_level_run_string_entries() {
        let config = parse(
            r#"{ "run": ["npm test", { "left": "npm run dev", "right": "npm run test:watch" }] }"#,
        )
        .expect("parse");
        assert_eq!(config.run.len(), 2);
        assert_eq!(config.run[0].as_str(), Some("npm test"));
    }

    #[test]
    fn rejects_invalid_run_split() {
        let error = parse(r#"{ "run": [{ "left": "a", "top": "b" }] }"#).expect_err("invalid");
        assert!(error.to_string().contains("exactly one split axis"));
    }

    #[test]
    fn rejects_empty_commands() {
        let error = parse(r#"{ "setup": [" "] }"#).expect_err("empty");
        assert!(error.to_string().contains("setup[0] must not be empty"));
    }

    #[test]
    fn rejects_unknown_keys() {
        let error = parse(r#"{ "nope": [] }"#).expect_err("unknown");
        assert!(error.to_string().contains("unknown key `nope`"));
    }
}
