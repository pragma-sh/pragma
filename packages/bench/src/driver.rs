//! Thin wrapper over the `tauri-agent-tools` CLI.
//!
//! Every interaction with the running app goes through this one place, and
//! always with `--pid`: a developer commonly has more than one Tauri dev build
//! open, and the CLI's auto-discovery would otherwise be free to pick the wrong
//! bridge — driving a benchmark's keystrokes into somebody's real editor.
//!
//! The pid is shared and re-resolvable rather than fixed, because Tauri's dev
//! watcher restarts the app during a normal run (see `bridge`). When a call
//! finds no bridge, the driver re-locates the app in its own process tree and
//! tries once more; the caller only sees an error if that fails too.

use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::bridge;
use crate::error::{BenchError, BenchResult};

/// Name of the CLI. Not a path: it is installed globally with npm, and the
/// resolved location differs per node version manager.
const TOOL: &str = "tauri-agent-tools";

/// Prefix the dev bridge puts on an exception it caught while evaluating.
const ERROR_PREFIX: &str = "ERROR: ";

/// What the CLI prints when the pid it was given has no bridge. Matched so a
/// restarted app is recognised and recovered from rather than reported.
const NO_BRIDGE: &str = "No bridge found";

/// Ceiling on one CLI invocation. The bridge itself gives up on an `eval` after
/// five seconds, so anything beyond this is the CLI hanging — which it does when
/// its target disappears mid-call, and which would otherwise wedge a run with no
/// output at all.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// How often a spawned CLI process is checked for completion.
const WAIT_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone)]
pub struct Driver {
    /// Pid of the app's bridge. Shared so a re-resolve is seen by every clone.
    app_pid: Arc<AtomicU32>,
    /// Pid of the `bun run dev` supervisor, used to re-find the app.
    dev_pid: u32,
    /// Bridges that predate this run and must never be adopted.
    foreign: Arc<Vec<u32>>,
}

impl Driver {
    #[must_use]
    pub fn new(app_pid: Arc<AtomicU32>, dev_pid: u32, foreign: Arc<Vec<u32>>) -> Self {
        Self {
            app_pid,
            dev_pid,
            foreign,
        }
    }

    /// The pid currently being driven.
    #[must_use]
    pub fn app_pid(&self) -> u32 {
        self.app_pid.load(Ordering::SeqCst)
    }

    /// Fails early, with an actionable message, when the CLI is not installed.
    pub fn check_available() -> BenchResult<()> {
        match Command::new(TOOL).arg("--version").output() {
            Ok(output) if output.status.success() => Ok(()),
            Ok(output) => Err(BenchError::Command {
                command: format!("{TOOL} --version"),
                status: output.status.to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            }),
            Err(_) => Err(BenchError::ToolMissing),
        }
    }

    /// Evaluates a JavaScript expression in the app's main window.
    pub fn eval(&self, expression: &str) -> BenchResult<Value> {
        self.run(&["eval", expression])
    }

    /// Evaluates a script file, used for the injected runner.
    pub fn eval_file(&self, path: &Path) -> BenchResult<Value> {
        let path = path.to_string_lossy().into_owned();
        self.run(&["eval", "--file", &path])
    }

    /// Calls a Tauri command by name, as the frontend would.
    pub fn invoke(&self, command: &str, args: &Value) -> BenchResult<Value> {
        let args = args.to_string();
        self.run(&["invoke", command, &args])
    }

    /// Re-resolves which app to drive. Returns the new pid when it changed.
    pub fn relocate(&self) -> Option<u32> {
        let found = bridge::locate(self.dev_pid, &self.foreign)?;
        let previous = self.app_pid.swap(found.pid, Ordering::SeqCst);
        (previous != found.pid).then_some(found.pid)
    }

    fn run(&self, args: &[&str]) -> BenchResult<Value> {
        match self.attempt(args) {
            Err(BenchError::BridgeGone) => {
                // The app was replaced mid-run. Adopt its successor and repeat
                // the call once; a second failure is reported as itself.
                let Some(pid) = self.relocate() else {
                    return Err(BenchError::BridgeGone);
                };
                println!("\n  dev app restarted; now driving pid {pid}");
                self.attempt(args)
            }
            other => other,
        }
    }

    fn attempt(&self, args: &[&str]) -> BenchResult<Value> {
        let pid = self.app_pid().to_string();
        let mut command = pragma_platform::process::command(TOOL);
        command.args(args).args(["--pid", &pid]);
        let output = output_with_timeout(&mut command, CALL_TIMEOUT, args)?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stdout.contains(NO_BRIDGE) || stderr.contains(NO_BRIDGE) {
            return Err(BenchError::BridgeGone);
        }
        if !output.status.success() {
            return Err(BenchError::Command {
                command: format!("{TOOL} {}", args.join(" ")),
                status: output.status.to_string(),
                stderr,
            });
        }
        if let Some(message) = stdout.strip_prefix(ERROR_PREFIX) {
            return Err(BenchError::Eval(message.to_string()));
        }
        // The bridge returns objects as JSON and everything else as a bare
        // string, so an unparseable payload is a value, not a failure.
        Ok(serde_json::from_str(&stdout).unwrap_or(Value::String(stdout)))
    }
}

/// Runs `command` to completion, killing it if it outlives `timeout`.
///
/// `Command::output` waits forever, and the CLI does hang when the bridge it was
/// pointed at has gone away. Output is read only after the process ends, which
/// is safe here because every response is small — the CLI prints a JSON value,
/// not a stream.
fn output_with_timeout(
    command: &mut Command,
    timeout: Duration,
    args: &[&str],
) -> BenchResult<Output> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| BenchError::ToolMissing)?;
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            return Ok(child.wait_with_output()?);
        }
        if started.elapsed() >= timeout {
            kill(&mut child);
            return Err(BenchError::Timeout {
                what: format!("`{TOOL} {}` to answer", args.join(" ")),
                waited: started.elapsed(),
            });
        }
        thread::sleep(WAIT_INTERVAL);
    }
}

fn kill(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_that_never_ends_is_killed_rather_than_waited_on() {
        let mut command = Command::new("sleep");
        command.arg("30");
        let error = output_with_timeout(&mut command, Duration::from_millis(200), &["sleep"])
            .expect_err("a sleeping command must hit the timeout");
        assert!(matches!(error, BenchError::Timeout { .. }), "got {error}");
    }

    #[test]
    fn a_command_that_finishes_returns_its_output() {
        let mut command = Command::new("echo");
        command.arg("hello");
        let output = output_with_timeout(&mut command, Duration::from_secs(5), &["echo"])
            .expect("echo completes");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "hello");
    }

    #[test]
    fn relocating_reports_only_an_actual_change() {
        let pid = std::process::id();
        let driver = Driver::new(Arc::new(AtomicU32::new(pid)), pid, Arc::new(vec![pid]));
        // The excluded pid is the only candidate, so there is nothing to adopt.
        assert_eq!(driver.relocate(), None);
        assert_eq!(driver.app_pid(), pid);
    }
}
