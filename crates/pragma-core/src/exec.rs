//! Host-side headless command execution behind the `exec` RPC method.
//!
//! Runs a batch of shell commands in a worktree directory on the host and
//! captures their output. Powers project setup/teardown scripts so they execute
//! on whichever machine owns the worktree — local or the remote box for an
//! SSH-bridged project. Interactive `run`/`build` scripts are *not* handled here;
//! those become PTY sessions.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::process_env;
use crate::{CoreError, CoreResult};

/// A batch of commands to run in `cwd` with extra environment variables.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecRequest {
    /// Working directory the commands run in (a worktree path on the host).
    pub cwd: String,
    /// Commands to run, each via the user's shell.
    pub commands: Vec<String>,
    /// Extra environment variables exported to every command.
    pub env: Vec<(String, String)>,
    /// Maximum commands to run concurrently (clamped to ≥1).
    pub max_concurrent: u32,
}

/// The captured result of one command.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    /// The command that ran.
    pub command: String,
    /// Captured stdout.
    pub stdout: String,
    /// Captured stderr.
    pub stderr: String,
    /// Exit code, or `None` if terminated by a signal / failed to spawn.
    pub status: Option<i32>,
    /// Wall-clock duration in milliseconds.
    pub duration_ms: u64,
}

/// Runs an `exec` RPC batch and returns one [`CommandResult`] per command, in
/// request order. Failures are reported in the results, not as an `Err`, so the
/// caller can format a combined message.
pub fn handle(payload: Value) -> CoreResult<Value> {
    let request: ExecRequest = serde_json::from_value(payload)
        .map_err(|error| CoreError::InvalidPayload(error.to_string()))?;
    let results = run(&request);
    serde_json::to_value(results).map_err(|error| CoreError::Operation(error.to_string()))
}

fn run(request: &ExecRequest) -> Vec<CommandResult> {
    if request.commands.is_empty() {
        return Vec::new();
    }
    let limit = usize::try_from(request.max_concurrent)
        .unwrap_or(usize::MAX)
        .max(1);
    let workers = limit.min(request.commands.len());
    let queue = Arc::new(Mutex::new(
        request
            .commands
            .iter()
            .cloned()
            .enumerate()
            .collect::<VecDeque<(usize, String)>>(),
    ));

    let mut handles = Vec::with_capacity(workers);
    for _ in 0..workers {
        let queue = Arc::clone(&queue);
        let cwd = request.cwd.clone();
        let env = request.env.clone();
        handles.push(std::thread::spawn(move || {
            let mut results = Vec::new();
            loop {
                let next = queue.lock().expect("exec queue not poisoned").pop_front();
                let Some((index, command)) = next else {
                    break;
                };
                results.push((index, run_one(&cwd, &env, &command)));
            }
            results
        }));
    }

    let mut indexed: Vec<Option<CommandResult>> = vec![None; request.commands.len()];
    for handle in handles {
        if let Ok(results) = handle.join() {
            for (index, result) in results {
                indexed[index] = Some(result);
            }
        }
    }
    indexed
        .into_iter()
        .map(|result| {
            result.unwrap_or_else(|| CommandResult {
                command: String::new(),
                stdout: String::new(),
                stderr: "command worker panicked".to_string(),
                status: None,
                duration_ms: 0,
            })
        })
        .collect()
}

fn run_one(cwd: &str, env: &[(String, String)], command: &str) -> CommandResult {
    let shell = pragma_platform::shell::default_shell();
    let started = Instant::now();
    let mut child = process_env::command(&shell);
    child
        .args(pragma_platform::shell::command_args(&shell, command))
        .current_dir(cwd);
    for (key, value) in env {
        child.env(key, value);
    }
    let output = child.output();
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match output {
        Ok(output) => CommandResult {
            command: command.to_string(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            status: output.status.code(),
            duration_ms,
        },
        Err(error) => CommandResult {
            command: command.to_string(),
            stdout: String::new(),
            stderr: format!("failed to spawn command: {error}"),
            status: None,
            duration_ms,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{run, ExecRequest};

    #[test]
    fn runs_commands_in_cwd_with_env() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Prove the working directory by reading a file that only resolves from
        // inside it. Comparing `pwd` output is not portable: under Git Bash on
        // Windows it prints an MSYS path (`/c/Users/…`) which never equals the
        // Win32 path `canonicalize` returns, so the assertion could not hold on
        // both platforms at once.
        std::fs::write(dir.path().join("marker.txt"), "in-cwd").expect("marker");
        let shell = pragma_platform::shell::default_shell();
        let command = match pragma_platform::shell::command_args(&shell, "")[0].as_str() {
            "-Command" => "Write-Output \"${env:GREETING}:$(Get-Content marker.txt -Raw)\"",
            "/C" => "echo %GREETING%: & type marker.txt",
            _ => "printf \"$GREETING:$(cat marker.txt)\"",
        };
        let results = run(&ExecRequest {
            cwd: dir.path().to_string_lossy().into_owned(),
            commands: vec![command.to_string()],
            env: vec![("GREETING".to_string(), "hi".to_string())],
            max_concurrent: 1,
        });
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].stdout.trim(), "hi:in-cwd");
        assert_eq!(results[0].status, Some(0));
    }

    #[test]
    fn reports_per_command_failure_without_erroring_the_batch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let results = run(&ExecRequest {
            cwd: dir.path().to_string_lossy().into_owned(),
            commands: vec!["exit 0".to_string(), "exit 7".to_string()],
            env: Vec::new(),
            max_concurrent: 2,
        });
        assert_eq!(results[0].status, Some(0));
        assert_eq!(results[1].status, Some(7));
    }
}
