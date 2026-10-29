//! End-to-end supervision tests for `pragma-cli agent run`, against a fake
//! host on a real Unix socket.
//!
//! These run the actual CLI binary as a child process, so they cover the whole
//! contract: the host must authorize an execution before the child starts, a
//! rejected authorization must leave the child unrun, and a completion the
//! host could not be told about must land in the durable journal.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use pragma_platform::ipc::{self, LocalListener};
use pragma_protocol::{
    read_json_frame, write_json_frame, HelloFrame, ProtocolErrorCode, RequestFrame, RpcError,
    RpcResponseFrame, ServerFrame,
};
use serde_json::{json, Value};
use tempfile::tempdir;

/// How the fake host answers one lifecycle op.
#[derive(Clone, Copy)]
enum Reply {
    Ok,
    Error(&'static str),
}

const SERVER_BOOT: &str = "boot-1";

struct FakeHost {
    socket: PathBuf,
    requests: Arc<Mutex<Vec<Value>>>,
    stop: Arc<AtomicBool>,
    /// Whether the completion journal existed when the first `finishRun`
    /// arrived — the wrapper must journal an ordinary exit *before* it tries
    /// to report it.
    journal_at_finish: Arc<Mutex<Option<bool>>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl FakeHost {
    /// Accepts connections until stopped, answering each `startRun` with
    /// `start` (plus a marker path) and each `finishRun` with `finish`.
    fn start(dir: &Path, start: Reply, finish: Reply) -> Self {
        Self::start_with_env(
            dir,
            start,
            finish,
            vec![(
                "PRAGMA_TEST_MARKER".to_string(),
                dir.join("child.txt").to_string_lossy().into_owned(),
            )],
        )
    }

    /// Like [`Self::start`], with account env returned by the start reply.
    fn start_with_env(dir: &Path, start: Reply, finish: Reply, env: Vec<(String, String)>) -> Self {
        let socket = dir.join("daemon.sock");
        let listener = ipc::bind(&socket).expect("bind fake host");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let journal_at_finish = Arc::new(Mutex::new(None));
        let thread_requests = Arc::clone(&requests);
        let thread_stop = Arc::clone(&stop);
        let thread_journal = Arc::clone(&journal_at_finish);
        let journal_dir = dir.join("agent-completions");
        let handle = thread::spawn(move || {
            serve(
                &listener,
                &thread_requests,
                &thread_stop,
                &thread_journal,
                &journal_dir,
                start,
                finish,
                &env,
            );
        });
        Self {
            socket,
            requests,
            stop,
            journal_at_finish,
            handle: Some(handle),
        }
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().expect("requests").clone()
    }

    fn journal_at_finish(&self) -> Option<bool> {
        *self.journal_at_finish.lock().expect("journal flag")
    }
}

impl Drop for FakeHost {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Wake a blocked accept with one throwaway connection.
        let _ = ipc::connect(&self.socket);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn serve(
    listener: &LocalListener,
    requests: &Arc<Mutex<Vec<Value>>>,
    stop: &Arc<AtomicBool>,
    journal_at_finish: &Arc<Mutex<Option<bool>>>,
    journal_dir: &Path,
    start: Reply,
    finish: Reply,
    env: &[(String, String)],
) {
    while !stop.load(Ordering::Relaxed) {
        let Ok((mut stream, _)) = listener.accept() else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
        if write_json_frame(
            &mut stream,
            &ServerFrame::Hello(HelloFrame {
                protocol_version: pragma_constants::CONSTANTS.daemon.protocol_version.clone(),
                build_id: None,
            }),
        )
        .is_err()
        {
            continue;
        }
        let Ok(request) = read_json_frame::<RequestFrame>(&mut stream) else {
            continue;
        };
        let Some(rpc) = request.rpc.as_ref() else {
            continue;
        };
        let action = rpc
            .payload
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        requests.lock().expect("requests").push(rpc.payload.clone());
        let reply = match action.as_str() {
            "startRun" => start,
            "finishRun" => finish,
            _ => Reply::Error("unexpected op"),
        };
        if action == "finishRun" {
            let run_id = rpc
                .payload
                .get("runId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let mut observed = journal_at_finish.lock().expect("journal flag");
            if observed.is_none() {
                *observed = Some(journal_dir.join(run_id).exists());
            }
        }
        let response = match reply {
            Reply::Ok => RpcResponseFrame {
                request_id: request.request_id.clone(),
                ok: true,
                payload: Some(match action.as_str() {
                    "startRun" => json!({
                        "ok": true,
                        "env": env,
                        "serverBootId": SERVER_BOOT,
                    }),
                    _ => json!({ "ok": true }),
                }),
                error: None,
            },
            Reply::Error(message) => RpcResponseFrame {
                request_id: request.request_id.clone(),
                ok: false,
                payload: None,
                error: Some(RpcError {
                    code: ProtocolErrorCode::Internal,
                    message: message.to_string(),
                    details: None,
                }),
            },
        };
        let _ = write_json_frame(&mut stream, &ServerFrame::Rpc(response));
    }
}

/// The CLI under test, pointed at the fake host.
fn cli(host: &FakeHost) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pragma-cli"));
    command
        .env("PRAGMA_SERVER_SOCKET", &host.socket)
        .env("PRAGMA_TEST_MARKER", host.socket.with_file_name("child.txt"))
        // Never let the session's own CLI delegation redirect this test.
        .env("PRAGMA_CLI_DELEGATED", "1");
    command
}

/// Run this test binary as the supervised child, avoiding shell-specific quoting.
fn marker_child() -> Vec<String> {
    vec![
        std::env::current_exe()
            .expect("test executable")
            .to_string_lossy()
            .into_owned(),
        "--exact".to_string(),
        "supervised_child_fixture".to_string(),
        "--ignored".to_string(),
    ]
}

/// Invoked only as a child by the supervision tests.
#[test]
#[ignore = "run only as the supervised child"]
fn supervised_child_fixture() {
    let marker = std::env::var_os("PRAGMA_TEST_MARKER").expect("marker path");
    let contents = std::env::var("PRAGMA_TEST_ACCOUNT").unwrap_or_else(|_| "child-ran".to_string());
    std::fs::write(marker, contents).expect("write child marker");
}

fn run_agent_run(host: &FakeHost, run_id: &str, child: &[String]) -> std::process::Output {
    cli(host)
        .args(["agent", "run", "--run-id", run_id, "--"])
        .args(child)
        .output()
        .expect("run pragma-cli")
}

#[test]
fn an_authorized_run_reports_start_and_finish() {
    let dir = tempdir().expect("tempdir");
    let host = FakeHost::start(dir.path(), Reply::Ok, Reply::Ok);
    let marker = dir.path().join("child.txt");

    let output = run_agent_run(&host, "run-1", &marker_child());

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(marker.exists(), "the authorized child ran");
    let requests = host.requests();
    let actions: Vec<&str> = requests
        .iter()
        .filter_map(|payload| payload.get("action").and_then(Value::as_str))
        .collect();
    assert_eq!(
        actions,
        ["startRun", "finishRun"],
        "the host authorizes the start and learns the real exit"
    );
    assert_eq!(requests[0]["runId"], json!("run-1"));
    assert_eq!(requests[1]["runId"], json!("run-1"));
    assert_eq!(requests[1]["exitCode"], json!(0));
    assert_eq!(
        requests[1]["serverBootId"],
        json!(SERVER_BOOT),
        "the wrapper echoes the authorizing server boot on the end report"
    );
    assert_eq!(
        host.journal_at_finish(),
        Some(true),
        "an ordinary exit is journaled durably before the finish report is attempted"
    );
}

#[test]
fn the_wrapper_applies_the_authorized_env_to_the_child() {
    let dir = tempdir().expect("tempdir");
    let host = FakeHost::start_with_env(
        dir.path(),
        Reply::Ok,
        Reply::Ok,
        vec![
            ("PRAGMA_TEST_ACCOUNT".to_string(), "acct-1".to_string()),
            (
                "PRAGMA_TEST_MARKER".to_string(),
                dir.path().join("env.txt").to_string_lossy().into_owned(),
            ),
        ],
    );
    let marker = dir.path().join("env.txt");

    let output = run_agent_run(&host, "run-1", &marker_child());

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(&marker)
            .expect("the child ran")
            .trim(),
        "acct-1",
        "the account env the host resolved for the recorded references reaches the child"
    );
}

/// A signal death is not an intentional end: SIGHUP is what a killed host's
/// terminal hangup delivers, and journaling it would suppress the recovery the
/// next host start should perform.
#[cfg(unix)]
#[test]
fn signal_deaths_are_not_journaled() {
    for (signal, expected_code) in [("HUP", 129), ("TERM", 143)] {
        let dir = tempdir().expect("tempdir");
        let host = FakeHost::start(dir.path(), Reply::Ok, Reply::Error("host is gone"));
        let child = vec![
            "sh".to_string(),
            "-c".to_string(),
            format!("kill -{signal} $$"),
        ];

        let output = run_agent_run(&host, "run-1", &child);

        assert_eq!(
            output.status.code(),
            Some(expected_code),
            "the wrapper reports the signal as 128+signal"
        );
        assert!(
            !dir.path().join("agent-completions").join("run-1").exists(),
            "a {signal} death is never journaled as an intentional exit"
        );
    }
}

#[test]
fn a_rejected_start_never_runs_the_child() {
    let dir = tempdir().expect("tempdir");
    let host = FakeHost::start(
        dir.path(),
        Reply::Error("stale agent run: run-1"),
        Reply::Ok,
    );
    let marker = dir.path().join("child.txt");

    let output = run_agent_run(&host, "run-1", &marker_child());

    assert!(!output.status.success(), "an unauthorized run fails");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("not authorized"),
        "the failure is surfaced: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        !marker.exists(),
        "the child must not run without an authorization"
    );
    let requests = host.requests();
    let actions: Vec<&str> = requests
        .iter()
        .filter_map(|payload| payload.get("action").and_then(Value::as_str))
        .collect();
    assert_eq!(
        actions,
        ["startRun"],
        "no end is reported for a child that never ran"
    );
}

#[test]
fn a_finish_the_host_never_hears_leaves_a_completion_journal() {
    let dir = tempdir().expect("tempdir");
    let host = FakeHost::start(dir.path(), Reply::Ok, Reply::Error("server is restarting"));
    let marker = dir.path().join("child.txt");

    let output = run_agent_run(&host, "run-1", &marker_child());

    assert!(
        output.status.success(),
        "the wrapper exits with the child's code: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(marker.exists(), "the child ran");
    let journal = dir.path().join("agent-completions").join("run-1");
    assert!(
        journal.exists(),
        "the completion is journaled beside the socket"
    );
    assert_eq!(
        std::fs::read_to_string(&journal)
            .expect("journal contents")
            .trim(),
        "0",
        "the journal carries the child's exit code"
    );
    assert!(
        !dir.path()
            .join("agent-completions")
            .join(".run-1.tmp")
            .exists(),
        "the journal write is atomic"
    );
}
