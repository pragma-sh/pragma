use std::fmt::Write as _;
use std::path::Path;
use std::time::Duration;

use pragma_constants::{FileContents, Project, ProtocolRpcMethod, Worktree, CONSTANTS};
use pragma_core::exec::{CommandResult, ExecRequest};
use pragma_core::fs::FsRequest;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::hosts::Hosts;
use crate::pty::PtyClient;

// The config contract itself lives in `pragma_core::scripts`: `pragma-server`
// parses the same file when a phone runs a script with no desktop window open,
// and two parsers would be two definitions of a valid `scripts.json`.
pub use pragma_core::scripts::ProjectScripts as LoadedProjectScripts;

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
#[tauri::command(async)]
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
    let config_path = Path::new(project_root).join(CONSTANTS.scripts.config_path.as_str());
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
        path: CONSTANTS.scripts.config_path.to_string(),
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
pub(crate) fn parse_config(raw: &str, path: &Path) -> AppResult<LoadedProjectScripts> {
    // Every failure the shared parser reports is a malformed config file, which
    // is this layer's `InvalidInput`; the wording already names the offending
    // path and key.
    pragma_core::scripts::parse_config(raw, path)
        .map_err(|error| AppError::InvalidInput(error.to_string()))
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

/// Runs one ad-hoc command in a worktree on its host and returns
/// stdout/stderr/status regardless of exit code. Used by `pragma-cli tab exec`
/// and `exec_in_worktree` so a non-zero exit is reported back to the caller
/// instead of being converted into a Tauri command error.
pub fn run_headless_command(
    pty: &PtyClient,
    project: &Project,
    worktree: &Worktree,
    command: &str,
) -> AppResult<HeadlessCommandResult> {
    let request = ExecRequest {
        cwd: worktree.path.clone(),
        commands: vec![command.to_string()],
        env: vec![
            ("PRAGMA_WORKTREE_PATH".to_string(), worktree.path.clone()),
            ("PRAGMA_PROJECT_PATH".to_string(), project.path.clone()),
            ("PRAGMA_WORKTREE_ID".to_string(), worktree.id.clone()),
        ],
        max_concurrent: 1,
    };
    let payload = serde_json::to_value(request)?;
    let value = pty.rpc(ProtocolRpcMethod::Exec, payload)?;
    let mut results: Vec<CommandResult> = serde_json::from_value(value)?;
    let result = results
        .pop()
        .ok_or_else(|| AppError::Script("command produced no result".to_string()))?;
    Ok(HeadlessCommandResult {
        command: result.command,
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
        duration: Duration::from_millis(result.duration_ms),
    })
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
        assert!(config.run_scripts.is_empty());
        assert!(config.teardown.is_empty());
    }

    #[test]
    fn accepts_build_script_with_icon() {
        let config = parse(
            r#"{ "runScripts": { "build": { "command": ["cargo build", { "left": "cargo build -p foo", "right": "cargo build -p bar" }], "icon": "lucide:hammer" } } }"#,
        )
        .expect("parse");
        let build = &config.run_scripts["build"];
        assert_eq!(build.command.len(), 2);
        assert_eq!(build.command[0].as_str(), Some("cargo build"));
        assert_eq!(build.icon.as_deref(), Some("lucide:hammer"));
    }

    #[test]
    fn accepts_run_script_without_icon() {
        let config = parse(
            r#"{ "runScripts": { "run": { "command": ["npm test", { "left": "npm run dev", "right": "npm run test:watch" }] } } }"#,
        )
        .expect("parse");
        let run = &config.run_scripts["run"];
        assert_eq!(run.command.len(), 2);
        assert_eq!(run.command[0].as_str(), Some("npm test"));
        assert_eq!(run.icon, None);
    }

    #[test]
    fn accepts_custom_named_script() {
        let config = parse(
            r#"{ "runScripts": { "lint": { "command": ["bun run lint"], "icon": "lucide:check" } } }"#,
        )
        .expect("parse");
        let lint = &config.run_scripts["lint"];
        assert_eq!(lint.command.len(), 1);
        assert_eq!(lint.icon.as_deref(), Some("lucide:check"));
    }

    #[test]
    fn rejects_invalid_run_split() {
        let error =
            parse(r#"{ "runScripts": { "run": { "command": [{ "left": "a", "top": "b" }] } } }"#)
                .expect_err("invalid");
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

    #[test]
    fn rejects_unknown_script_definition_keys() {
        let error = parse(r#"{ "runScripts": { "run": { "command": [], "bogus": true } } }"#)
            .expect_err("unknown");
        assert!(error.to_string().contains("unknown key `bogus`"));
    }
}
