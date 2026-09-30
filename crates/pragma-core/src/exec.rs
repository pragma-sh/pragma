//! Host-side headless command execution behind the `exec` RPC method.
//!
//! Runs a batch of shell commands in a worktree directory on the host and
//! captures their output. Powers project setup/teardown scripts so they execute
//! on whichever machine owns the worktree — local or the remote box for an
//! SSH-bridged project. Interactive `run`/`build` scripts are *not* handled here;
//! those become PTY sessions.
//!
//! A batch may carry a `runId`. While it runs, a second `exec` call with
//! `{ "cancelRunId": … }` — on its own connection — kills the batch's live
//! process trees and skips its queued commands; each affected result comes
//! back with `cancelled: true` and whatever output it produced before then.

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
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
    /// Caller-chosen id that a later [`ExecCancel`] names to stop this batch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// Stops the running batch registered under `cancel_run_id`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecCancel {
    /// The [`ExecRequest::run_id`] to cancel.
    pub cancel_run_id: String,
}

/// Either shape the `exec` RPC accepts. `Cancel` is tried first: its one
/// required field never appears on a run request.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ExecPayload {
    Cancel(ExecCancel),
    Run(ExecRequest),
}

/// Live state of one cancellable batch.
#[derive(Default)]
struct RunState {
    cancelled: bool,
    pids: Vec<u32>,
}

/// Batches that carry a `runId`, keyed by it, for the duration of the batch.
static RUNS: LazyLock<Mutex<HashMap<String, RunState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn runs() -> std::sync::MutexGuard<'static, HashMap<String, RunState>> {
    RUNS.lock().unwrap_or_else(PoisonError::into_inner)
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
    /// The batch was cancelled before this command finished (or started).
    #[serde(default)]
    pub cancelled: bool,
}

/// Runs an `exec` RPC batch and returns one [`CommandResult`] per command, in
/// request order. Failures are reported in the results, not as an `Err`, so the
/// caller can format a combined message. A cancel payload instead answers
/// `{ "cancelled": bool }` — whether a batch with that id was running.
pub fn handle(payload: Value) -> CoreResult<Value> {
    let payload: ExecPayload = serde_json::from_value(payload)
        .map_err(|error| CoreError::InvalidPayload(error.to_string()))?;
    match payload {
        ExecPayload::Cancel(cancel) => Ok(serde_json::json!({
            "cancelled": cancel_run(&cancel.cancel_run_id),
        })),
        ExecPayload::Run(request) => serde_json::to_value(run(&request))
            .map_err(|error| CoreError::Operation(error.to_string())),
    }
}

/// Marks `run_id` cancelled and kills every process tree it has running.
/// Returns whether such a batch was running.
fn cancel_run(run_id: &str) -> bool {
    let pids = {
        let mut runs = runs();
        let Some(state) = runs.get_mut(run_id) else {
            return false;
        };
        state.cancelled = true;
        std::mem::take(&mut state.pids)
    };
    for pid in pids {
        let _ = pragma_platform::process::kill_process_tree(pid);
    }
    true
}

/// Registers a batch's `run_id` for its lifetime so [`cancel_run`] can find it.
struct RunGuard(Option<String>);

impl RunGuard {
    fn new(run_id: Option<&String>) -> Self {
        if let Some(run_id) = run_id {
            runs().insert(run_id.clone(), RunState::default());
        }
        Self(run_id.cloned())
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Some(run_id) = &self.0 {
            runs().remove(run_id);
        }
    }
}

fn is_cancelled(run_id: Option<&str>) -> bool {
    run_id.is_some_and(|id| runs().get(id).is_some_and(|state| state.cancelled))
}

fn run(request: &ExecRequest) -> Vec<CommandResult> {
    if request.commands.is_empty() {
        return Vec::new();
    }
    let _guard = RunGuard::new(request.run_id.as_ref());
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
        let run_id = request.run_id.clone();
        handles.push(std::thread::spawn(move || {
            let mut results = Vec::new();
            loop {
                let next = queue.lock().expect("exec queue not poisoned").pop_front();
                let Some((index, command)) = next else {
                    break;
                };
                results.push((index, run_one(&cwd, &env, &command, run_id.as_deref())));
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
                cancelled: false,
            })
        })
        .collect()
}

fn run_one(
    cwd: &str,
    env: &[(String, String)],
    command: &str,
    run_id: Option<&str>,
) -> CommandResult {
    if is_cancelled(run_id) {
        return CommandResult {
            command: command.to_string(),
            stdout: String::new(),
            stderr: String::new(),
            status: None,
            duration_ms: 0,
            cancelled: true,
        };
    }
    let shell = pragma_platform::shell::default_shell();
    let started = Instant::now();
    let mut child = process_env::command(&shell);
    child
        .args(pragma_platform::shell::command_args(&shell, command))
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        child.env(key, value);
    }
    let output = child.spawn().and_then(|child| {
        track_pid(run_id, child.id());
        child.wait_with_output()
    });
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let cancelled = is_cancelled(run_id);
    match output {
        Ok(output) => CommandResult {
            command: command.to_string(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            status: output.status.code(),
            duration_ms,
            cancelled,
        },
        Err(error) => CommandResult {
            command: command.to_string(),
            stdout: String::new(),
            stderr: format!("failed to spawn command: {error}"),
            status: None,
            duration_ms,
            cancelled,
        },
    }
}

/// Records a spawned command's pid under its batch, or kills it at once when
/// a cancel landed between the queue pop and the spawn.
fn track_pid(run_id: Option<&str>, pid: u32) {
    let Some(run_id) = run_id else {
        return;
    };
    let cancelled = {
        let mut runs = runs();
        match runs.get_mut(run_id) {
            Some(state) if state.cancelled => true,
            Some(state) => {
                state.pids.push(pid);
                false
            }
            None => false,
        }
    };
    if cancelled {
        let _ = pragma_platform::process::kill_process_tree(pid);
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{cancel_run, run, ExecRequest};

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
            run_id: None,
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
            run_id: None,
        });
        assert_eq!(results[0].status, Some(0));
        assert_eq!(results[1].status, Some(7));
    }

    #[test]
    fn cancel_unknown_run_reports_nothing_cancelled() {
        assert!(!cancel_run("exec-test-no-such-run"));
    }

    #[test]
    fn cancel_kills_running_command_and_skips_queued_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shell = pragma_platform::shell::default_shell();
        let sleep = match pragma_platform::shell::command_args(&shell, "")[0].as_str() {
            "-Command" => "Start-Sleep -Seconds 30",
            "/C" => "ping -n 31 127.0.0.1 > NUL",
            _ => "sleep 30",
        };
        let run_id = "exec-test-cancel".to_string();
        let request = ExecRequest {
            cwd: dir.path().to_string_lossy().into_owned(),
            commands: vec![sleep.to_string(), "exit 0".to_string()],
            env: Vec::new(),
            max_concurrent: 1,
            run_id: Some(run_id.clone()),
        };
        let started = Instant::now();
        let worker = std::thread::spawn(move || run(&request));
        // Wait for the batch to register its first pid before cancelling it.
        let deadline = Instant::now() + Duration::from_secs(10);
        while super::runs()
            .get(&run_id)
            .is_none_or(|state| state.pids.is_empty())
        {
            assert!(Instant::now() < deadline, "command never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(cancel_run(&run_id));
        let results = worker.join().expect("worker");
        assert!(started.elapsed() < Duration::from_secs(20));
        assert!(results[0].cancelled);
        assert!(results[1].cancelled);
        assert_eq!(results[1].status, None);
        assert!(super::runs().get(&run_id).is_none());
    }
}
