//! `pragma-cli agent run --run-id <id> -- <argv…>`: supervise one prepared
//! agent invocation.
//!
//! The host wraps a resume-capable agent's launch in this command, so the
//! agent runs in the tab's own terminal while the host learns when the child
//! actually started and when it actually exited. Everything else is the
//! child's: stdin, stdout, and stderr are inherited, so the TUI stays
//! interactive and job control treats one foreground job.
//!
//! Two rules are load-bearing:
//!
//! - **`ended` follows the child's real exit and nothing else.** A cleared
//!   agent status, a watcher exiting, or this process disconnecting never
//!   closes the record. If the child outlives the report attempt, the record
//!   stays active and the host treats it as interrupted on its next start.
//! - **Terminal signals must not kill the supervisor before it reports.** A
//!   Ctrl-C reaches the whole foreground process group, the agent's TUI and
//!   this wrapper included. The wrapper catches SIGINT/SIGTERM/SIGHUP so it
//!   survives to report the child's exit; the child is exec'd with default
//!   dispositions, so Ctrl-C still reaches it normally.
//! - **Only an ordinary exit is journaled, and it is journaled before the
//!   report is attempted.** A code exit is durable evidence the child ended;
//!   writing the completion entry first means a host that dies mid-retry still
//!   sees it. A signal death is never journaled: SIGHUP is exactly what a
//!   killed host's terminal hangup delivers, and treating it as an intentional
//!   end would suppress the recovery that should happen.

use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

use pragma_constants::ProtocolRpcMethod;
use serde_json::json;

use crate::output;
use crate::server::{self, CliError};

/// Environment variable that marks a child as belonging to a tracked run.
/// Every `pragma-cli agent report` inside it carries the id back.
pub const AGENT_RUN_ID_ENV: &str = "PRAGMA_AGENT_RUN_ID";

/// Directory beside the socket where a completion the server could not be
/// told about is journaled. Mirrors `pragma-server`'s
/// `invocations::COMPLETIONS_DIR`; the CLI cannot depend on the server crate,
/// so the name is pinned by tests on both sides.
const COMPLETIONS_DIR: &str = "agent-completions";

/// How often a failed lifecycle report is retried, and how many times. The
/// start is worth a few quick attempts; the end is worth a slightly longer
/// window because the server may be mid-restart when the agent exits, but the
/// wrapper must still hand the terminal back promptly.
const REPORT_RETRY_DELAY: Duration = Duration::from_millis(400);
const START_ATTEMPTS: usize = 3;
const FINISH_ATTEMPTS: usize = 8;
/// Every lifecycle report is bounded: a server that accepts the connection and
/// then wedges must not pin the terminal after the agent has already exited.
const REPORT_TIMEOUT: Duration = Duration::from_secs(1);

/// How the supervised child ended, as observed by this process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildExit {
    /// The child exited with a code of its own: an ordinary, intentional end.
    Code(i32),
    /// The child was killed by a signal. On Unix a terminal hangup caused by
    /// the host dying arrives here — not an intentional end.
    Signal(i32),
    /// The platform could not say how the child ended.
    Unknown,
}

impl ChildExit {
    fn observe(status: std::process::ExitStatus) -> Self {
        if let Some(code) = status.code() {
            return Self::Code(code);
        }
        if let Some(signal) = pragma_platform::process::exit_signal(&status) {
            return Self::Signal(signal);
        }
        Self::Unknown
    }

    /// Only a code exit is durable evidence of an intentional end. A signal
    /// may be a user's kill, an external supervisor, or the host's own death
    /// reaching the terminal (SIGHUP); classifying it as intentional would
    /// suppress a recovery that should happen, so it is never journaled.
    fn is_intentional(self) -> bool {
        matches!(self, Self::Code(_))
    }

    /// The code this wrapper exits with, following the shell convention for
    /// signals (128 + signal) so the caller sees the cause.
    fn process_code(self) -> u8 {
        match self {
            Self::Code(code) => u8::try_from(code).unwrap_or(1),
            Self::Signal(signal) => u8::try_from(128 + signal).unwrap_or(1),
            Self::Unknown => 1,
        }
    }

    fn exit_code(self) -> Option<i32> {
        match self {
            Self::Code(code) => Some(code),
            Self::Signal(_) | Self::Unknown => None,
        }
    }
}

/// Runs the supervised child and reports its lifecycle.
pub fn run(args: &crate::cli::AgentRunArgs, _out: &output::Output) -> Result<(), CliError> {
    survive_terminal_signals();

    let Some((program, rest)) = args.command.split_first() else {
        return Err(CliError::config("agent run requires a command after `--`"));
    };

    // The host must authorize the execution before the child exists. This is
    // not just bookkeeping: an unauthorized run has no record, so nothing
    // could ever resume it, and letting the child start anyway would run an
    // agent the host does not know about. The reply carries the env resolved
    // from the record's saved account references, which this wrapper applies
    // to the child directly — the execution then runs under the account the
    // launch was prepared with even if the shell's spawn-time env resolved
    // differently or timed out. A crash between the authorization and the
    // spawn leaves a record the host marks interrupted (not one it never
    // restores), which is the honest state.
    let authorized = match authorized_run(&args.run_id) {
        Ok(authorized) => authorized,
        Err(error) => {
            return Err(CliError::other(format!(
                "agent run {} was not authorized by the host: {error}",
                args.run_id
            )));
        }
    };

    let mut command = pragma_platform::process::command(program);
    command.args(rest);
    for (key, value) in &authorized.env {
        command.env(key, value);
    }
    // The agent reports its harness session id through the CLI, which reads
    // this to attribute the report to the right invocation. Set last so the
    // account env can never shadow it.
    command.env(AGENT_RUN_ID_ENV, &args.run_id);
    // stdin/stdout/stderr stay inherited: the child owns the terminal.

    match command.status() {
        Ok(status) => {
            let exit = ChildExit::observe(status);
            // Durable intent first for an ordinary exit: if the host dies
            // while the retries run, its next start must still see the end.
            let journaled = journal_intentional_exit(&args.run_id, exit);
            // The real child exit — the one and only `ended` signal.
            if let Err(error) = report_run(
                &args.run_id,
                "finishRun",
                exit.exit_code(),
                authorized.server_boot_id.as_deref(),
                FINISH_ATTEMPTS,
            ) {
                report_failure(&args.run_id, exit, journaled, &error);
            }
            flush_and_exit(exit.process_code());
        }
        Err(error) => {
            // A spawn failure says nothing about the saved conversation: keep
            // it interrupted so recovery can retry after the executable is fixed.
            let reason = format!("could not run {program}: {error}");
            if let Err(report) = report_failure_run(
                &args.run_id,
                &reason,
                authorized.server_boot_id.as_deref(),
                FINISH_ATTEMPTS,
            ) {
                eprintln!("pragma-cli agent run: could not report spawn failure: {report}");
            }
            Err(CliError::other(reason))
        }
    }
}

fn report_failure_run(
    run_id: &str,
    reason: &str,
    server_boot_id: Option<&str>,
    attempts: usize,
) -> Result<serde_json::Value, CliError> {
    let mut payload = json!({ "action": "failRun", "runId": run_id, "reason": reason });
    if let Some(server_boot_id) = server_boot_id.filter(|id| !id.is_empty()) {
        payload["serverBootId"] = json!(server_boot_id);
    }
    let mut last_error = None;
    for attempt in 0..attempts {
        match server::rpc_with_timeout(
            ProtocolRpcMethod::Tabs,
            payload.clone(),
            Some(REPORT_TIMEOUT),
        ) {
            Ok(reply) => return Ok(reply),
            Err(error) if is_stale(&error) => return Err(error),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < attempts {
            std::thread::sleep(REPORT_RETRY_DELAY);
        }
    }
    Err(last_error.unwrap_or_else(|| CliError::other("agent run failure report failed")))
}

/// Journals an ordinary exit before any report attempt. Returns whether a
/// durable entry exists; a failure is surfaced, never swallowed.
fn journal_intentional_exit(run_id: &str, exit: ChildExit) -> bool {
    if !exit.is_intentional() {
        return false;
    }
    match write_completion_journal(run_id, exit.exit_code()) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("pragma-cli agent run: could not journal the run's completion: {error}");
            false
        }
    }
}

/// Surfaces a completion the host never heard. A stale run is final and needs
/// nothing; otherwise the failure is reported, and when there is no durable
/// journal entry the reason it could not be recorded is spelled out.
fn report_failure(run_id: &str, exit: ChildExit, journaled: bool, error: &CliError) {
    if is_stale(error) || journaled {
        return;
    }
    if exit.is_intentional() {
        eprintln!(
            "pragma-cli agent run: could not report run {run_id}'s completion and it was not journaled: {error}"
        );
    } else {
        eprintln!(
            "pragma-cli agent run: run {run_id} ended by signal (not journaled; the host may have died with the terminal): {error}"
        );
    }
}

/// What the host's `startRun` authorized: the child's env and the server boot
/// that authorized it.
struct AuthorizedRun {
    env: Vec<(String, String)>,
    /// Echoed on `finishRun`. A wrapper from a previous server boot must not be
    /// able to end the record the new boot is recovering.
    server_boot_id: Option<String>,
}

/// Authorizes the run with the host. The reply is
/// `{ ok: true, env: [[key, value], …], serverBootId }`; an older host that
/// omits `env` means the harness default and one that omits the boot id keeps
/// the legacy finish semantics.
fn authorized_run(run_id: &str) -> Result<AuthorizedRun, CliError> {
    let reply = report_run(run_id, "startRun", None, None, START_ATTEMPTS)?;
    let env = match reply.get("env") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(_)) => {
            serde_json::from_value(reply["env"].clone()).map_err(|error| {
                CliError::other(format!("host returned an invalid start env: {error}"))
            })?
        }
        Some(other) => {
            return Err(CliError::other(format!(
                "host returned an invalid start env: {other}"
            )));
        }
    };
    let server_boot_id = reply
        .get("serverBootId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    Ok(AuthorizedRun {
        env,
        server_boot_id,
    })
}

/// Journals a completion the server could not be told about, before this
/// process returns the shell. Written atomically (temp + rename, synced), and
/// consumed by `pragma-server`'s startup replay — an execution whose wrapper
/// finished must never be reconciled into `interrupted` and resurrected.
fn write_completion_journal(run_id: &str, exit_code: Option<i32>) -> Result<(), String> {
    let socket = server::socket_path()?;
    let parent = Path::new(&socket)
        .parent()
        .ok_or_else(|| format!("socket path has no directory: {socket}"))?;
    let dir = parent.join(COMPLETIONS_DIR);
    pragma_platform::perms::create_private_dir(&dir).map_err(|error| error.to_string())?;
    let target = dir.join(run_id);
    let temp = dir.join(format!(".{run_id}.tmp"));
    let mut file =
        pragma_platform::perms::create_private_file(&temp).map_err(|error| error.to_string())?;
    let contents = exit_code.map_or_else(String::new, |code| code.to_string());
    file.write_all(contents.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    std::fs::rename(&temp, &target).map_err(|error| error.to_string())
}

/// Sends one `startRun`/`finishRun` op, retrying transient failures. A stale
/// run id is final: the host has retired the record, and retrying cannot
/// change that.
fn report_run(
    run_id: &str,
    action: &str,
    exit_code: Option<i32>,
    server_boot_id: Option<&str>,
    attempts: usize,
) -> Result<serde_json::Value, CliError> {
    let mut payload = json!({ "action": action, "runId": run_id });
    if let Some(exit_code) = exit_code {
        payload["exitCode"] = json!(exit_code);
    }
    if let Some(server_boot_id) = server_boot_id.filter(|id| !id.is_empty()) {
        // Only the end report is boot-bound; the start is what receives the id.
        payload["serverBootId"] = json!(server_boot_id);
    }
    let mut last_error = None;
    for attempt in 0..attempts {
        match server::rpc_with_timeout(
            ProtocolRpcMethod::Tabs,
            payload.clone(),
            Some(REPORT_TIMEOUT),
        ) {
            Ok(reply) => return Ok(reply),
            Err(error) if is_stale(&error) => return Err(error),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < attempts {
            std::thread::sleep(REPORT_RETRY_DELAY);
        }
    }
    Err(last_error.unwrap_or_else(|| CliError::other("agent run report failed")))
}

/// True when the host rejected the run id as stale (superseded or ended).
fn is_stale(error: &CliError) -> bool {
    matches!(error, CliError::Server(message) if message.contains("stale agent run"))
}

/// Hands the child's exit code back to the shell. Exits the process directly
/// so the shell sees the agent's own status; buffered output is flushed first.
fn flush_and_exit(code: u8) -> ! {
    use std::io::Write as _;
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    std::process::exit(code.into());
}

/// Catches terminal-generated signals for the process's lifetime, without
/// installing a handler in the child (exec resets caught dispositions, so the
/// agent's TUI still receives Ctrl-C).
fn survive_terminal_signals() {
    if let Err(error) = pragma_platform::process::survive_terminal_signals() {
        eprintln!("pragma-cli agent run: could not guard terminal signals: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::is_stale;
    use crate::server::CliError;

    #[test]
    fn a_stale_run_is_final_but_a_transport_failure_is_retried() {
        assert!(is_stale(&CliError::server("stale agent run: run-1")));
        assert!(!is_stale(&CliError::server(
            "connect to /tmp/daemon.sock: no such file"
        )));
    }
}
