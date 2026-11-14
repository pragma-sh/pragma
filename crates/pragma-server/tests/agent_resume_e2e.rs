//! End-to-end crash/recover regression for the durable agent invocation flow:
//! prepare → real supervisor → real reporter → `SQLite` → crash → proactive
//! restore → deliberate exit → close-tab suppression → pid-only SIGKILL →
//! reported session clear.
//!
//! Two crash shapes are covered, because they are not the same failure:
//!
//! - **Tree kill** (phase 2): the update/restart path, where the server and
//!   every descendant die together. The supervisor never gets to report.
//! - **PID-only SIGKILL** (phase 5): `kill -9 <server-pid>`. The PTY master
//!   closes, the harness dies of SIGHUP, and the signal-guarding supervisor
//!   *survives* to exhaust its finish-report retries and write its completion
//!   journal. That journal must not turn a server crash into an intentional
//!   end: the exact reported conversation has to come back.
//!
//! Everything here is the real thing, not a seam:
//!
//! - the actual `pragma-server` binary (`CARGO_BIN_EXE_pragma-server`),
//! - the actual `pragma-plugins` sidecar (`bun packages/plugins-host/src/cli.ts`,
//!   the same dev resolution the server uses), fed a temp project whose
//!   `.pragma/config.json` points at a fake plugin that opts into
//!   `launch.resume` and returns a fixed resume argv (relative entries resolve
//!   from the config file's own directory, so the bundle is `../fake-plugin`),
//! - the actual `pragma-cli` binary, staged into the isolated channel's
//!   `bin/` exactly as the desktop stages it, used both as the `agent run`
//!   supervisor and as the native reporter inside the fake harness,
//! - a real PTY session the test drives over the wire protocol.
//!
//! The test runs in a private channel with a fixture `HOME` (no global
//! plugins, no credentials), its own app-data dir, and no gateway: the fake
//! plugin has static models, so nothing reaches the network. The crash kills
//! only the server process tree the test itself started.
//!
//! Unix-only: the fake harness is a POSIX shell script and the crash semantics
//! (`kill_process_tree` + PTY teardown) are asserted on Unix. The Windows
//! equivalents need a PowerShell harness and a job-object crash, which is a
//! separate change; on Windows this test compiles to nothing rather than
//! pretending to run.

#![cfg(unix)]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use pragma_constants::{Project, ProtocolRpcMethod, Tab, TabKind, WorkspaceSnapshot, Worktree};
use pragma_platform::ipc::{self, LocalStream};
use pragma_protocol::{
    read_json_frame, write_json_frame, RequestFrame, RequestKind, RpcRequest, ServerFrame,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use tempfile::TempDir;

/// The worktree id every published snapshot uses.
const WORKTREE_ID: &str = "worktree-main";
/// The qualified catalog id of the fake plugin's resume-capable agent.
const AGENT_ID: &str = "pragma.test-fake.fake-agent";
/// The conversation id the fake harness reports second; the one a restore must
/// resume.
const SESSION_B: &str = "session-B";
/// A string only the original launch argv carries. Its absence from the
/// resumed argv is the "no prompt/startup replay" assertion.
const ORIGINAL_PROMPT: &str = "ORIGINAL-PROMPT-MARKER";
/// A lower bound on how long the supervisor's finish-report retry window can
/// take: 8 attempts × (1s report timeout + 400ms retry delay) ≈ 11.2s. The
/// pid-only crash phase waits at least this long after the kill, so the
/// supervisor's genuine exit handling (journaling) has fully run before the
/// restart — waiting only for its exit could miss a mid-retry journal.
const FINISH_RETRY_WINDOW: Duration = Duration::from_secs(15);

static REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);

fn next_request_id() -> String {
    let seq = REQUEST_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("e2e-{}-{seq}", std::process::id())
}

/// Everything one isolated run needs: a temp root, the fixture home, the
/// staged CLI, and the fake plugin/harness files.
struct Fixture {
    /// Kept alive for the whole test; the server writes beside it.
    _tmp: Option<TempDir>,
    base: PathBuf,
    home: PathBuf,
    data: PathBuf,
    channel: String,
    project: PathBuf,
    harness: PathBuf,
    marker: PathBuf,
    exit_file: PathBuf,
    cli: PathBuf,
    server_bin: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let tmp = TempDir::new().expect("tempdir");
        // `PRAGMA_E2E_KEEP=1` keeps the fixture for post-mortem inspection.
        let keep = std::env::var_os("PRAGMA_E2E_KEEP").is_some();
        let (base, tmp_guard) = if keep {
            (tmp.keep(), None)
        } else {
            (tmp.path().to_path_buf(), Some(tmp))
        };
        eprintln!("[e2e] fixture base: {}", base.display());
        let home = base.join("home");
        let data = base.join("data");
        let project = base.join("project");
        for dir in [&home, &data, &project] {
            fs::create_dir_all(dir).expect("fixture dir");
        }
        let channel = format!("agent-resume-e2e-{}", std::process::id());
        let server_bin = PathBuf::from(env!("CARGO_BIN_EXE_pragma-server"));
        let cli_source = server_bin
            .parent()
            .expect("the server binary has a parent")
            .join(format!("pragma-cli{}", std::env::consts::EXE_SUFFIX));
        if !cli_source.is_file() {
            // A caller that asked only for this test target has not built the
            // sibling CLI; build the real binary rather than skipping the
            // regression. The workspace-wide `cargo test` already has it.
            let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
            let status = Command::new(cargo)
                .args(["build", "-p", "pragma-cli"])
                .current_dir(env!("CARGO_MANIFEST_DIR"))
                .status()
                .expect("run cargo build -p pragma-cli");
            assert!(status.success(), "cargo build -p pragma-cli failed");
        }
        assert!(
            cli_source.is_file(),
            "the e2e test needs the real pragma-cli beside the server binary at {}",
            cli_source.display()
        );
        // The server resolves its session CLI at `<PRAGMA_APP_DATA_DIR>/<channel>/bin/pragma-cli`;
        // stage the real binary there, exactly like the desktop does.
        let cli = data
            .join(&channel)
            .join("bin")
            .join(format!("pragma-cli{}", std::env::consts::EXE_SUFFIX));
        fs::create_dir_all(cli.parent().expect("cli parent")).expect("cli dir");
        fs::copy(&cli_source, &cli).expect("stage pragma-cli");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).expect("cli executable");
        }

        let harness = base.join("fake-harness.sh");
        let marker = base.join("harness-calls.txt");
        let exit_file = base.join("harness-exit");
        let fixture = Self {
            _tmp: tmp_guard,
            base,
            home,
            data,
            channel,
            project,
            harness,
            marker,
            exit_file,
            cli,
            server_bin,
        };
        fixture.write_fake_plugin();
        fixture.write_fake_harness();
        fixture
    }

    fn server_dir(&self) -> PathBuf {
        self.data.join(&self.channel)
    }

    fn socket(&self) -> PathBuf {
        ipc::socket_path_in(&self.server_dir())
    }

    fn invocations_db(&self) -> PathBuf {
        self.server_dir().join("agent-invocations.db")
    }

    /// The temp project's `.pragma/config.json` + plugin bundle. The plugin
    /// carries the resume argv the host must use verbatim.
    ///
    /// Relative plugin paths resolve against the directory containing the
    /// config file (`<project>/.pragma`), matching the desktop and `plugins.rs`
    /// semantics — so the bundle beside the project is `../fake-plugin`, not
    /// `./fake-plugin`.
    fn write_fake_plugin(&self) {
        let plugin_dir = self.project.join("fake-plugin");
        fs::create_dir_all(&plugin_dir).expect("plugin dir");
        fs::create_dir_all(self.project.join(".pragma")).expect("project pragma dir");
        fs::write(
            self.project.join(".pragma/config.json"),
            json!({ "plugins": [{ "path": "../fake-plugin" }] }).to_string(),
        )
        .expect("project config");
        fs::write(
            plugin_dir.join("package.json"),
            json!({ "name": "pragma.test-fake", "version": "1.0.0", "main": "index.mjs" })
                .to_string(),
        )
        .expect("plugin package.json");
        let harness = serde_json::to_string(&self.harness.to_string_lossy()).expect("harness json");
        let marker = serde_json::to_string(&self.marker.to_string_lossy()).expect("marker json");
        let exit_file =
            serde_json::to_string(&self.exit_file.to_string_lossy()).expect("exit json");
        let bundle = format!(
            r#"// Fake Pragma plugin for the invocation e2e test: one resume-capable agent.
const HARNESS = {harness};
const MARKER = {marker};
const EXIT_FILE = {exit_file};
export default {{
  id: "pragma.test-fake",
  agents: [
    {{
      id: "fake-agent",
      name: "Fake Agent",
      launch: {{
        command: [HARNESS, "--prompt", "{ORIGINAL_PROMPT}"],
        resume: (request) => [
          HARNESS,
          "--resume",
          request.harnessSessionId,
          "--marker",
          MARKER,
          "--exit-file",
          EXIT_FILE,
        ],
      }},
      models: [],
      permissionModes: [],
      args: {{ model: () => [], reasoning: () => [] }},
    }},
  ],
}};
"#
        );
        fs::write(plugin_dir.join("index.mjs"), bundle).expect("plugin bundle");
    }

    /// The fake harness the supervisor actually runs. It records the argv it
    /// received, reports two harness session ids through the real CLI (original
    /// launch only), then idles until the test asks it to exit.
    fn write_fake_harness(&self) {
        let marker = sh_quote(&self.marker);
        let exit_file = sh_quote(&self.exit_file);
        let script = format!(
            r#"#!/bin/sh
# Fake harness for the invocation e2e test. It records its argv, reports the
# harness session ids through the real native reporter, then idles.
set -u
marker={marker}
exit_file={exit_file}
cli="${{PRAGMA_CLI:-}}"
{{
  printf 'CALL %s\n' "${{PRAGMA_AGENT_RUN_ID:-unknown}}"
  for arg in "$@"; do printf 'ARG %s\n' "$arg"; done
  printf 'CALL-END\n'
}} >> "$marker"
case "$*" in
  *--resume*)
    ;;
  *)
    if [ -n "$cli" ]; then
      "$cli" agent report --agent fake-agent session-id --id session-A >/dev/null 2>&1 || true
      sleep 0.4
      "$cli" agent report --agent fake-agent session-id --id {SESSION_B} >/dev/null 2>&1 || true
    else
      printf 'ERROR no PRAGMA_CLI\n' >> "$marker"
    fi
    ;;
esac
i=0
while [ ! -f "$exit_file" ] && [ "$i" -lt 900 ]; do
  sleep 0.2
  i=$((i + 1))
done
exit 0
"#,
        );
        fs::write(&self.harness, script).expect("harness script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.harness, fs::Permissions::from_mode(0o755))
                .expect("harness executable");
        }
    }

    /// The argv the caller (desktop) prepares for the agent.
    fn original_command(&self) -> Vec<String> {
        vec![
            self.harness.to_string_lossy().into_owned(),
            "--prompt".to_string(),
            ORIGINAL_PROMPT.to_string(),
        ]
    }
}

/// POSIX single-quote a path for the generated shell script.
fn sh_quote(path: &Path) -> String {
    let raw = path.to_string_lossy();
    assert!(
        !raw.contains('\''),
        "fixture paths must not contain single quotes: {raw}"
    );
    format!("'{raw}'")
}

/// A published snapshot: one project/worktree and the given terminal tabs.
fn workspace_snapshot(fixture: &Fixture, tab_ids: &[&str]) -> WorkspaceSnapshot {
    WorkspaceSnapshot {
        projects: vec![Project {
            id: "project-1".to_string(),
            name: "e2e".to_string(),
            path: fixture.project.to_string_lossy().into_owned(),
            icon_emoji: None,
            order_index: 0,
            created_at: "2026-01-01 00:00:00".to_string(),
            is_git: true,
        }],
        worktrees: vec![Worktree {
            id: WORKTREE_ID.to_string(),
            project_id: "project-1".to_string(),
            parent_id: None,
            branch: "main".to_string(),
            title: None,
            path: fixture.project.to_string_lossy().into_owned(),
            is_main: true,
            hidden: false,
            created_at: "2026-01-01 00:00:00".to_string(),
        }],
        tabs: tab_ids
            .iter()
            .map(|id| Tab {
                id: (*id).to_string(),
                project_id: "project-1".to_string(),
                worktree_id: WORKTREE_ID.to_string(),
                kind: TabKind::Terminal,
                title: Some("fake agent".to_string()),
                url: None,
                file_path: None,
                diff_side: None,
                diff_commit: None,
                pr_number: None,
                plugin_id: None,
                plugin_view_id: None,
                plugin_payload: None,
                plugin_dedupe_key: None,
                whiteboard_id: None,
                agent_id: None,
                fanout_id: None,
                fanout_member_id: None,
                user_renamed: false,
                shell: None,
                order_index: 0,
                created_at: "2026-01-01 00:00:00".to_string(),
            })
            .collect(),
    }
}

/// The real server binary, started in a private channel. Killing it kills the
/// whole process tree the test started (sidecar, PTY shells, supervisors).
struct Server {
    child: Child,
    socket: PathBuf,
    log: PathBuf,
}

impl Server {
    fn start(fixture: &Fixture) -> Self {
        let log = fixture.base.join(format!(
            "server-{}.log",
            REQUEST_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let stdout = fs::File::create(&log).expect("server log");
        let stderr = stdout.try_clone().expect("server log clone");
        let child = Command::new(&fixture.server_bin)
            .env("PRAGMA_APP_DATA_DIR", &fixture.data)
            .env("XDG_RUNTIME_DIR", &fixture.data)
            .env("PRAGMA_SERVER_CHANNEL", &fixture.channel)
            .env("PRAGMA_DAEMON_CHANNEL", &fixture.channel)
            .env("HOME", &fixture.home)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .spawn()
            .expect("the isolated server starts");
        let server = Self {
            child,
            socket: fixture.socket(),
            log,
        };
        // The socket file appears before the hello is written; `connect`
        // retries, and the first RPC reads the hello.
        wait_for_socket(&server.socket);
        server
    }

    /// Kills the server and every process it spawned (sidecar, PTY shells, the
    /// supervisor, the fake harness). Only this test's tree.
    fn crash(&mut self) {
        let _ = pragma_platform::process::kill_process_tree(self.child.id());
        let _ = self.child.wait();
    }

    /// Kills only the server process, leaving its descendants alive: the
    /// `kill -9 <server-pid>` crash shape, where the PTY master closes and the
    /// harness dies of SIGHUP while the supervisor survives to journal.
    fn kill_server_pid_only(&mut self) {
        let _ = pragma_platform::process::kill(self.child.id());
        let _ = self.child.wait();
    }

    fn log_tail(&self) -> String {
        fs::read_to_string(&self.log)
            .map(|contents| {
                let lines: Vec<&str> = contents.lines().rev().take(40).collect();
                lines.into_iter().rev().collect::<Vec<_>>().join("\n")
            })
            .unwrap_or_default()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.crash();
    }
}

/// Kills `server`'s whole tree and starts a fresh process on the same channel
/// and state directory.
fn restart(fixture: &Fixture, server: Server) -> Server {
    let mut previous = server;
    previous.crash();
    Server::start(fixture)
}

/// Every descendant of `root` right now, as `(pid, executable name)`, from one
/// process-table snapshot. Captured before a pid-only kill so the survivors can
/// be cleaned up later without touching anything the test did not start.
fn descendants_of(root: u32) -> Vec<(u32, String)> {
    let processes = pragma_platform::process::list_processes().expect("process table");
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, entry) in &processes {
        children.entry(entry.parent_pid).or_default().push(pid);
    }
    let mut descendants = Vec::new();
    let mut seen = HashSet::from([root]);
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for &child in children.get(&parent).into_iter().flatten() {
            if seen.insert(child) {
                if let Some(entry) = processes.get(&child) {
                    descendants.push((child, entry.name.clone()));
                }
                frontier.push(child);
            }
        }
    }
    descendants
}

/// Waits (bounded) for a pid to disappear from the process table.
fn wait_for_process_exit(pid: u32, description: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let alive = pragma_platform::process::list_processes()
            .is_ok_and(|processes| processes.contains_key(&pid));
        if !alive {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {description} ({pid}) to exit"
        );
        thread::sleep(Duration::from_millis(100));
    }
}

fn wait_for_socket(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while ipc::connect(socket).is_err() {
        assert!(
            Instant::now() < deadline,
            "the server never listened at {}",
            socket.display()
        );
        thread::sleep(Duration::from_millis(50));
    }
}

fn connect(socket: &Path) -> LocalStream {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match ipc::connect(socket) {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(Duration::from_mins(1)))
                    .expect("read timeout");
                stream
                    .set_write_timeout(Some(Duration::from_mins(1)))
                    .expect("write timeout");
                return stream;
            }
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Err(error) => panic!("connect to {}: {error}", socket.display()),
        }
    }
}

fn expect_hello(stream: &mut LocalStream) {
    match read_json_frame::<ServerFrame>(stream).expect("hello frame") {
        ServerFrame::Hello(_) => {}
        other => panic!("expected a hello frame, got {other:?}"),
    }
}

fn request_frame(request_id: &str, kind: RequestKind) -> RequestFrame {
    RequestFrame {
        request_id: request_id.to_string(),
        kind,
        session_id: None,
        worktree_id: None,
        cwd: None,
        cols: None,
        rows: None,
        data: None,
        shell: None,
        rpc: None,
        subscription: None,
        control: None,
        control_result: None,
        env: None,
    }
}

/// One RPC round trip on its own connection.
fn rpc(server: &Server, method: ProtocolRpcMethod, payload: Value) -> Value {
    let mut stream = connect(&server.socket);
    expect_hello(&mut stream);
    let request_id = next_request_id();
    let mut frame = request_frame(&request_id, RequestKind::Rpc);
    frame.rpc = Some(RpcRequest { method, payload });
    write_json_frame(&mut stream, &frame).expect("write rpc");
    loop {
        let frame = read_json_frame::<ServerFrame>(&mut stream).expect("rpc response frame");
        if let ServerFrame::Rpc(response) = frame {
            assert_eq!(response.request_id, request_id, "response correlation");
            assert!(
                response.ok,
                "rpc {method:?} failed: {:?}\n--- server log ---\n{}",
                response.error,
                server.log_tail()
            );
            return response.payload.unwrap_or(Value::Null);
        }
    }
}

/// Fire-and-forget frame (publish, write).
fn send(server: &Server, frame: &RequestFrame) {
    let mut stream = connect(&server.socket);
    expect_hello(&mut stream);
    write_json_frame(&mut stream, frame).expect("write fire-and-forget frame");
}

fn publish_workspace(server: &Server, fixture: &Fixture, tab_ids: &[&str]) {
    let snapshot = workspace_snapshot(fixture, tab_ids);
    let mut frame = request_frame(&next_request_id(), RequestKind::PublishWorkspace);
    frame.data = Some(serde_json::to_string(&snapshot).expect("snapshot json"));
    send(server, &frame);
}

/// Spawns a real PTY session for the tab and waits for the spawn acknowledgement.
fn spawn_session(server: &Server, fixture: &Fixture, tab_id: &str) {
    let mut stream = connect(&server.socket);
    expect_hello(&mut stream);
    let mut frame = request_frame(&next_request_id(), RequestKind::Spawn);
    frame.session_id = Some(tab_id.to_string());
    frame.worktree_id = Some(WORKTREE_ID.to_string());
    frame.cwd = Some(fixture.project.to_string_lossy().into_owned());
    frame.cols = Some(120);
    frame.rows = Some(30);
    write_json_frame(&mut stream, &frame).expect("spawn request");
    match read_json_frame::<ServerFrame>(&mut stream).expect("spawn response") {
        ServerFrame::Response(response) => assert!(
            response.ok,
            "spawn {tab_id} failed: {:?}\n--- server log ---\n{}",
            response.error,
            server.log_tail()
        ),
        other => panic!("expected a spawn response, got {other:?}"),
    }
}

/// Types one command line into the session's shell.
fn write_command(server: &Server, tab_id: &str, command: &[String]) {
    let launch = pragma_platform::shell::resolve_profile_launch(
        &pragma_platform::shell::default_profile(),
        None,
    );
    let line = pragma_platform::shell::interactive_command_line(&launch.program, command);
    let mut frame = request_frame(&next_request_id(), RequestKind::Write);
    frame.session_id = Some(tab_id.to_string());
    frame.data = Some(format!("{line}\r"));
    send(server, &frame);
}

/// One row of the on-disk invocation store, read directly with `SQLite`.
#[derive(Debug, Clone)]
struct Record {
    invocation_id: String,
    run_id: String,
    state: String,
    harness_session_id: Option<String>,
    command: String,
    exit_code: Option<i64>,
    tab_id: String,
}

fn read_record(fixture: &Fixture, tab_id: &str) -> Option<Record> {
    let connection = Connection::open(fixture.invocations_db()).ok()?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .expect("busy timeout");
    let mut statement = connection
        .prepare(
            "SELECT invocation_id, run_id, state, harness_session_id, command, exit_code, tab_id
               FROM agent_invocations
              WHERE worktree_id = ?1 AND tab_id = ?2
              ORDER BY seq DESC LIMIT 1",
        )
        .ok()?;
    let mut rows = statement.query(params![WORKTREE_ID, tab_id]).ok()?;
    let row = rows.next().ok()??;
    Some(Record {
        invocation_id: row.get(0).expect("invocation_id"),
        run_id: row.get(1).expect("run_id"),
        state: row.get(2).expect("state"),
        harness_session_id: row.get(3).expect("harness_session_id"),
        command: row.get(4).expect("command"),
        exit_code: row.get(5).expect("exit_code"),
        tab_id: row.get(6).expect("tab_id"),
    })
}

fn wait_record(
    server: &Server,
    fixture: &Fixture,
    tab_id: &str,
    description: &str,
    predicate: impl Fn(&Record) -> bool,
) -> Record {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(record) = read_record(fixture, tab_id) {
            if predicate(&record) {
                return record;
            }
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {description} on tab {tab_id}\n--- server log ---\n{}",
            server.log_tail()
        );
        thread::sleep(Duration::from_millis(100));
    }
}

/// One harness invocation: the run id it saw in `PRAGMA_AGENT_RUN_ID` and the
/// argv it was executed with.
#[derive(Debug)]
struct HarnessCall {
    run_id: String,
    args: Vec<String>,
}

fn harness_calls(marker: &Path) -> Vec<HarnessCall> {
    let Ok(contents) = fs::read_to_string(marker) else {
        return Vec::new();
    };
    let mut calls = Vec::new();
    let mut current: Option<HarnessCall> = None;
    for line in contents.lines() {
        if let Some(run_id) = line.strip_prefix("CALL ") {
            current = Some(HarnessCall {
                run_id: run_id.to_string(),
                args: Vec::new(),
            });
        } else if let Some(arg) = line.strip_prefix("ARG ") {
            if let Some(call) = current.as_mut() {
                call.args.push(arg.to_string());
            }
        } else if line == "CALL-END" {
            if let Some(call) = current.take() {
                calls.push(call);
            }
        }
    }
    calls
}

fn wait_for_calls(marker: &Path, count: usize) -> Vec<HarnessCall> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let calls = harness_calls(marker);
        if calls.len() >= count {
            return calls;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {count} harness calls (saw {})",
            calls.len()
        );
        thread::sleep(Duration::from_millis(100));
    }
}

/// Waits for the plugin catalog to resolve the fake agent.
fn wait_for_catalog(server: &Server) {
    let deadline = Instant::now() + Duration::from_mins(1);
    loop {
        let catalog = rpc(
            server,
            ProtocolRpcMethod::Plugins,
            json!({ "action": "catalog" }),
        );
        let agents = catalog["agents"].as_array().cloned().unwrap_or_default();
        if agents.iter().any(|agent| agent["id"] == AGENT_ID) {
            // The fixture HOME is empty and the only registered root is the
            // temp project, so nothing from the real user's config can appear.
            assert_eq!(
                agents.len(),
                1,
                "the isolated catalog must contain exactly the fake agent: {catalog}"
            );
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the fake agent never appeared in the catalog: {catalog}\n--- server log ---\n{}",
            server.log_tail()
        );
        thread::sleep(Duration::from_millis(200));
    }
}

/// Runs the opt-in launch path: prepare (records the invocation) → real PTY →
/// the wrapped `pragma-cli agent run` command typed into the shell.
fn prepare_and_launch(server: &Server, fixture: &Fixture, tab_id: &str) -> (String, Vec<String>) {
    let prepared = rpc(
        server,
        ProtocolRpcMethod::Tabs,
        json!({
            "action": "prepareAgentLaunch",
            "tabId": tab_id,
            "worktreeId": WORKTREE_ID,
            "agentId": AGENT_ID,
            "command": fixture.original_command(),
            "selection": null,
        }),
    );
    let run_id = prepared["runId"]
        .as_str()
        .expect("an opted-in agent is tracked")
        .to_string();
    let command: Vec<String> = serde_json::from_value(prepared["command"].clone())
        .expect("the wrapped command is an argv");
    assert_eq!(
        command[0],
        fixture.cli.to_string_lossy(),
        "the wrapper is the staged pragma-cli"
    );
    assert_eq!(
        &command[1..5],
        ["agent", "run", "--run-id", run_id.as_str()],
        "the command is wrapped in the supervisor"
    );
    assert_eq!(command[5], "--");
    assert_eq!(
        &command[6..],
        fixture.original_command(),
        "the original argv is passed through"
    );

    spawn_session(server, fixture, tab_id);
    // The shell needs a moment before typed input lands at its prompt — the
    // same readiness wait every launch path uses, plus margin.
    thread::sleep(
        Duration::from_millis(pragma_constants::CONSTANTS.agents.start_delay_ms)
            + Duration::from_millis(400),
    );
    write_command(server, tab_id, &command);
    (run_id, command)
}

/// A tab that is already live and has reported `SESSION_B` through the real
/// reporter, with the original launch's argv recorded by the fake harness.
fn launch_and_report_b(server: &Server, fixture: &Fixture, tab_id: &str) -> Record {
    let calls_before = harness_calls(&fixture.marker).len();
    let (run_id, _) = prepare_and_launch(server, fixture, tab_id);
    let record = wait_record(
        server,
        fixture,
        tab_id,
        "an active run with session B",
        |r| r.state == "active" && r.harness_session_id.as_deref() == Some(SESSION_B),
    );
    assert_eq!(
        record.run_id, run_id,
        "the active execution is the prepared one"
    );

    let calls = wait_for_calls(&fixture.marker, calls_before + 1);
    let call = calls.last().expect("the new harness call");
    assert_eq!(call.run_id, run_id, "the harness saw the wrapped run id");
    assert!(
        call.args.iter().any(|arg| arg == ORIGINAL_PROMPT),
        "the original launch carries the prompt: {:?}",
        call.args
    );
    record
}

/// Asserts one harness call is the verbatim resume of the exact reported
/// conversation, under the given execution, with no original prompt replayed.
fn assert_resume_call(call: &HarnessCall, run_id: &str, exit_file: &Path) {
    assert_eq!(call.run_id, run_id, "the resumed supervisor's run id");
    let args = &call.args;
    let index = args
        .iter()
        .position(|arg| arg == "--resume")
        .unwrap_or_else(|| panic!("the resumed argv names the conversation: {args:?}"));
    assert_eq!(
        args[index + 1],
        SESSION_B,
        "the exact reported harness session id is resumed"
    );
    assert!(
        !args.iter().any(|arg| arg == ORIGINAL_PROMPT),
        "no prompt/startup input is replayed into a resume: {args:?}"
    );
    assert_eq!(
        args.last().map(String::as_str),
        Some(exit_file.to_string_lossy().as_ref()),
        "the full resume argv reached the harness: {args:?}"
    );
}

/// The desktop's `restoreAgentSession` RPC, returning its `restored` flag.
fn restore_agent_session(server: &Server, tab_id: &str) -> bool {
    rpc(
        server,
        ProtocolRpcMethod::Tabs,
        json!({ "action": "restoreAgentSession", "tabId": tab_id, "worktreeId": WORKTREE_ID }),
    )["restored"]
        .as_bool()
        .expect("restored flag")
}

/// Reports `session-id --clear` for a tracked run through the real CLI — the
/// same status-less report a plugin sends when its conversation disappears.
fn clear_harness_session_id(fixture: &Fixture, server: &Server, tab_id: &str, run_id: &str) {
    let status = Command::new(&fixture.cli)
        .args([
            "agent",
            "report",
            "--agent",
            "fake-agent",
            "session-id",
            "--clear",
        ])
        .env("PRAGMA_SERVER_SOCKET", &server.socket)
        .env("PRAGMA_TAB_ID", tab_id)
        .env("PRAGMA_WORKTREE_ID", WORKTREE_ID)
        .env("PRAGMA_AGENT_RUN_ID", run_id)
        // Never let a session's exported CLI redirect this direct invocation.
        .env("PRAGMA_CLI_DELEGATED", "1")
        .stdout(Stdio::null())
        .status()
        .expect("run pragma-cli session-id --clear");
    assert!(status.success(), "the clear report must exit 0");
}

/// The whole regression is one ordered narrative — prepare, tree crash,
/// pid-only crash, recover, exit, close, clear — and splitting it across
/// helpers would hide the sequencing the test exists to pin.
#[test]
#[allow(clippy::too_many_lines)]
fn prepare_report_crash_recover_and_close_end_to_end() {
    let fixture = Fixture::new();
    let mut server = Server::start(&fixture);

    // --- phase 1: isolated catalog, prepare, real PTY, reports A then B -----
    publish_workspace(&server, &fixture, &["tab-1"]);
    rpc(
        &server,
        ProtocolRpcMethod::Plugins,
        json!({ "action": "registerRoots", "roots": [fixture.project.to_string_lossy()] }),
    );
    wait_for_catalog(&server);
    let original = launch_and_report_b(&server, &fixture, "tab-1");
    assert!(
        fixture.invocations_db().is_file(),
        "the SQLite store exists beside the socket"
    );
    assert!(
        original.command.contains(ORIGINAL_PROMPT),
        "the durable record keeps the original argv: {}",
        original.command
    );

    // --- phase 2: tree kill (update-like); the same channel/state restores --
    server = restart(&fixture, server);
    let resumed = wait_record(
        &server,
        &fixture,
        "tab-1",
        "the proactive restore to become active under a fresh run",
        |r| {
            r.state == "active"
                && r.run_id != original.run_id
                && r.harness_session_id.as_deref() == Some(SESSION_B)
        },
    );
    assert_eq!(
        resumed.invocation_id, original.invocation_id,
        "the conversation context survives; only the execution rotates"
    );
    assert_eq!(resumed.tab_id, "tab-1", "the restore lands in the same tab");
    assert_eq!(
        resumed.command, original.command,
        "the record still stores the original argv"
    );
    let calls = wait_for_calls(&fixture.marker, 2);
    assert_eq!(
        calls.len(),
        2,
        "exactly one resumed execution, not a fresh launch"
    );
    assert_resume_call(&calls[1], &resumed.run_id, &fixture.exit_file);

    // --- phase 3: deliberate exit ends the record; a restart never relaunches
    fs::write(&fixture.exit_file, b"").expect("ask the harness to exit");
    let ended = wait_record(&server, &fixture, "tab-1", "the ended record", |r| {
        r.state == "ended"
    });
    assert_eq!(
        ended.exit_code,
        Some(0),
        "the child's real exit is recorded"
    );

    server = restart(&fixture, server);
    assert!(
        !restore_agent_session(&server, "tab-1"),
        "an ended record is never restored"
    );
    // The proactive pass would have run by now; an ended record must not move.
    thread::sleep(Duration::from_secs(5));
    assert_eq!(
        harness_calls(&fixture.marker).len(),
        2,
        "a restart after a deliberate exit must not relaunch the harness"
    );
    let still_ended = read_record(&fixture, "tab-1").expect("record");
    assert_eq!(still_ended.state, "ended");
    assert_eq!(still_ended.run_id, ended.run_id);

    // --- phase 4: closing the tab suppresses restore on the next restart ----
    fs::remove_file(&fixture.exit_file).ok();
    publish_workspace(&server, &fixture, &["tab-1", "tab-2"]);
    launch_and_report_b(&server, &fixture, "tab-2");
    rpc(
        &server,
        ProtocolRpcMethod::Tabs,
        json!({ "action": "close", "tabId": "tab-2" }),
    );
    let closed = wait_record(&server, &fixture, "tab-2", "the closed tab's record", |r| {
        r.state == "ended"
    });
    let calls_before = harness_calls(&fixture.marker).len();
    assert_eq!(calls_before, 3, "one original launch per tab");

    server = restart(&fixture, server);
    assert!(
        !restore_agent_session(&server, "tab-2"),
        "a closed tab is tombstoned and never restored"
    );
    thread::sleep(Duration::from_secs(5));
    assert_eq!(
        harness_calls(&fixture.marker).len(),
        calls_before,
        "a closed tab must not be relaunched after a restart"
    );
    let closed_after = read_record(&fixture, "tab-2").expect("record");
    assert_eq!(closed_after.state, "ended");
    assert_eq!(closed_after.run_id, closed.run_id);

    // --- phase 5: SIGKILL the server PID only (no tree) ---------------------
    // The crash shape a real `kill -9` produces: the PTY master closes, the
    // harness dies of SIGHUP, and the signal-guarding supervisor survives to
    // exhaust its finish-report retries and write its completion journal. That
    // journal must not turn the crash into an intentional end — the exact
    // reported conversation has to come back.
    publish_workspace(&server, &fixture, &["tab-1", "tab-3"]);
    let calls_before_pid_crash = harness_calls(&fixture.marker).len();
    let crashed = launch_and_report_b(&server, &fixture, "tab-3");
    let descendants = descendants_of(server.child.id());
    let supervisor = descendants
        .iter()
        .find(|(_, name)| name.contains("pragma-cli"))
        .map(|(pid, _)| *pid)
        .expect("the agent-run supervisor is a descendant of the server");
    let killed_at = Instant::now();
    server.kill_server_pid_only();
    // Wait out the supervisor's finish-report retry window: its genuine exit
    // handling must have fully run before the restart.
    wait_for_process_exit(supervisor, "the agent-run supervisor");
    thread::sleep(FINISH_RETRY_WINDOW.saturating_sub(killed_at.elapsed()));
    let journal = fixture
        .server_dir()
        .join("agent-completions")
        .join(&crashed.run_id);
    eprintln!(
        "[e2e] pid-only crash: completion journal present = {}; record state = {:?}",
        journal.is_file(),
        read_record(&fixture, "tab-3").map(|record| record.state)
    );
    // No end ever reached the host over the socket: the durable record is
    // still active, so the crash is an interruption, not an exit.
    assert_eq!(
        read_record(&fixture, "tab-3").expect("record").state,
        "active",
        "the pid-only crash must not be recorded as an end through the socket"
    );
    // Clean up only the descendants this pid-only kill left behind.
    for (pid, name) in &descendants {
        if pragma_platform::process::is_running(*pid, name) {
            let _ = pragma_platform::process::kill(*pid);
        }
    }

    server = restart(&fixture, server);
    let recovered = wait_record(
        &server,
        &fixture,
        "tab-3",
        "the pid-only crash to recover the exact reported conversation",
        |r| {
            r.state == "active"
                && r.run_id != crashed.run_id
                && r.harness_session_id.as_deref() == Some(SESSION_B)
        },
    );
    assert_eq!(
        recovered.invocation_id, crashed.invocation_id,
        "the conversation context survives the pid-only crash"
    );
    let calls = wait_for_calls(&fixture.marker, calls_before_pid_crash + 2);
    let call = calls.last().expect("the resumed call");
    assert_resume_call(call, &recovered.run_id, &fixture.exit_file);
    // End tab-3's resumed session deliberately: an active record would be
    // resumed again by the next phase's restart and blur its count.
    fs::write(&fixture.exit_file, b"").expect("ask tab-3's resumed harness to exit");
    wait_record(
        &server,
        &fixture,
        "tab-3",
        "tab-3's resumed run to end",
        |r| r.state == "ended",
    );
    fs::remove_file(&fixture.exit_file).ok();

    // --- phase 6: a reported session clear resets the store; no old resume --
    publish_workspace(&server, &fixture, &["tab-1", "tab-3", "tab-4"]);
    let calls_before_clear = harness_calls(&fixture.marker).len();
    let cleared = launch_and_report_b(&server, &fixture, "tab-4");
    clear_harness_session_id(&fixture, &server, "tab-4", &cleared.run_id);
    let after_clear = wait_record(
        &server,
        &fixture,
        "tab-4",
        "the cleared conversation to leave no resume pointer",
        |r| r.harness_session_id.is_none(),
    );
    assert_eq!(
        after_clear.state, "active",
        "a clear is metadata, not an end"
    );

    server = restart(&fixture, server);
    assert!(
        !restore_agent_session(&server, "tab-4"),
        "a cleared conversation is never restored"
    );
    thread::sleep(Duration::from_secs(5));
    assert_eq!(
        harness_calls(&fixture.marker).len(),
        calls_before_clear + 1,
        "a cleared conversation must not resume the old id after a restart"
    );
    let cleared_after = read_record(&fixture, "tab-4").expect("record");
    assert_eq!(cleared_after.state, "interrupted");
    assert!(cleared_after.harness_session_id.is_none());

    server.crash();
}
