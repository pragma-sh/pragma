//! Direct-to-server readers that do not need the running app:
//! - `tab read` — attach to a session, collect replayed scrollback frames,
//!   optionally stay attached and stream new output (`--watch`).
//! - `agent status` — subscribe to agents, print the snapshot, optionally
//!   keep the subscription open and print deltas (`--watch`).
//! - `agent report` — write one `AgentReport` frame and exit (unchanged
//!   logic, only the command path moved).

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use pragma_protocol::{
    read_frame, read_json_frame, write_json_frame, EventFrame, Frame, RequestFrame, RequestKind,
    ResponseFrame, ServerFrame,
};
use uuid::Uuid;

use crate::server::{self, env, CliError, Server};
use crate::{output, scrollback};

/// Default attach grid. The CLI does not render a terminal, so a fixed grid
/// drives the server's scrollback sizing.
const ATTACH_COLS: u16 = 80;
const ATTACH_ROWS: u16 = 24;

/// Assembles the scrollback bytes from a session attach (collecting output
/// frames), then optionally streams live output. Server scrollback is a capped
/// frame buffer; there is no delimiter between replayed scrollback and live
/// output, so non-watch mode drains a short burst (bounded by
/// [`READ_TIMEOUT`]) then detaches, while `--watch` streams until the session
/// exits or Ctrl-C.
pub fn tab_read(args: &crate::cli::TabReadArgs, out: &output::Output) -> Result<(), CliError> {
    let Server { mut stream } = server::connect()?;
    let request = attach_request(&args.tab);
    write_json_frame(&mut stream, &request)?;
    // Wait for the attach ack response before collecting scrollback frames.
    wait_response(&mut stream, &request.request_id)?;
    if args.watch {
        let _ = stream.set_read_timeout(None);
    } else {
        // Bound the scrollback drain so a quiet session does not wedge the CLI.
        let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    }
    let mode = if args.raw {
        scrollback::Mode::Raw
    } else {
        scrollback::Mode::Plain
    };
    let mut acc = scrollback::Accumulator::new(mode, args.lines, args.offset, args.bytes);
    loop {
        match read_frame(&mut stream) {
            Ok(Frame::Output { data, .. }) => acc.push_output(&data),
            // The server never sends an `Input` frame back to a client.
            Ok(Frame::Input { .. }) => {}
            Ok(Frame::Json(bytes)) => {
                let Ok(server_frame) = serde_json::from_slice::<ServerFrame>(&bytes) else {
                    continue;
                };
                match server_frame {
                    ServerFrame::Event(EventFrame::Output { data, .. }) => acc.push_output(&data),
                    ServerFrame::Event(EventFrame::Exit { .. }) => break,
                    _ => {}
                }
            }
            Err(pragma_protocol::ProtocolError::Io(ref e))
                if !args.watch && e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                // Read timed out: scrollback burst drained. Detach.
                break;
            }
            Err(_) => break,
        }
    }
    if out.is_structured() {
        let bytes = acc.finish_bytes();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        out.line(
            "",
            &serde_json::json!({
                "tabId": args.tab,
                "bytes": bytes.len(),
                "data": text,
                "truncated": false,
            }),
        );
    } else {
        acc.flush(std::io::stdout())?;
    }
    if args.watch {
        scrollback::Watcher::new(true).stream(&mut stream)?;
    }
    Ok(())
}

/// How long a non-watch `tab read` waits for additional scrollback frames
/// before deciding the server's replay burst is done.
const READ_TIMEOUT: Duration = Duration::from_millis(200);

fn attach_request(session_id: &str) -> RequestFrame {
    RequestFrame {
        request_id: Uuid::new_v4().to_string(),
        kind: RequestKind::Attach,
        session_id: Some(session_id.to_string()),
        worktree_id: None,
        cwd: None,
        cols: Some(ATTACH_COLS),
        rows: Some(ATTACH_ROWS),
        data: None,
        rpc: None,
        subscription: None,
        control: None,
        control_result: None,
    }
}

/// Waits for the `Response` to an attach/agent-report request, erroring on a
/// negative ack.
fn wait_response(stream: &mut UnixStream, request_id: &str) -> Result<(), CliError> {
    loop {
        let frame = read_json_frame::<ServerFrame>(stream)?;
        match frame {
            ServerFrame::Response(ResponseFrame {
                request_id: id,
                ok,
                error,
            }) if id == request_id => {
                if ok {
                    return Ok(());
                }
                return Err(CliError::server(
                    error.unwrap_or_else(|| "request rejected".to_string()),
                ));
            }
            // Scrollback frames arrive alongside the ack; tolerate them.
            _ => {}
        }
    }
}

// -------------------------- agent status --------------------------

/// One row of the agent status snapshot. Mirrors `EventFrame::Agent`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusRow {
    pub worktree_id: String,
    pub tab_id: String,
    pub agent: String,
    pub status: String,
    pub attention_kind: Option<String>,
}

/// Subscribes to agent status, prints the snapshot (one row per agent), and
/// with `--watch` keeps streaming deltas until the subscription ends.
pub fn agent_status(
    args: &crate::cli::AgentStatusArgs,
    out: &output::Output,
) -> Result<(), CliError> {
    let Server { mut stream } = server::connect()?;
    let request = subscribe_agents_request();
    write_json_frame(&mut stream, &request)?;
    let mut rows: Vec<AgentStatusRow> = Vec::new();
    loop {
        match read_json_frame::<ServerFrame>(&mut stream) {
            Ok(ServerFrame::Event(EventFrame::Agent {
                worktree_id,
                tab_id,
                agent,
                status,
                attention_kind,
            })) => {
                rows.push(AgentStatusRow {
                    worktree_id,
                    tab_id,
                    agent,
                    status: status_wire(status),
                    attention_kind: attention_kind.map(attention_wire),
                });
            }
            Ok(ServerFrame::Response(ResponseFrame { ok, error, .. })) => {
                if !ok {
                    return Err(CliError::server(
                        error.unwrap_or_else(|| "agent subscription rejected".to_string()),
                    ));
                }
                // Snapshot fully delivered once a non-Agent frame arrives; the
                // server interleaves the ack with the snapshot, so break after
                // we've seen the ack and at least one agent... but an empty
                // snapshot has no Agent frames. To be safe, break on the ack.
                break;
            }
            Ok(_) => {}
            Err(error) => return Err(CliError::from(error)),
        }
    }
    render_status(&rows, out);
    if args.watch {
        stream_deltas(&mut stream, args, out)?;
    }
    Ok(())
}

fn stream_deltas(
    stream: &mut UnixStream,
    args: &crate::cli::AgentStatusArgs,
    out: &output::Output,
) -> Result<(), CliError> {
    loop {
        match read_json_frame::<ServerFrame>(stream) {
            Ok(ServerFrame::Event(EventFrame::Agent {
                worktree_id,
                tab_id,
                agent,
                status,
                attention_kind,
            })) => {
                let row = AgentStatusRow {
                    worktree_id,
                    tab_id,
                    agent,
                    status: status_wire(status),
                    attention_kind: attention_kind.map(attention_wire),
                };
                if args.worktree.is_some()
                    && args
                        .worktree
                        .as_deref()
                        .is_some_and(|w| w != row.worktree_id)
                {
                    continue;
                }
                render_status(std::slice::from_ref(&row), out);
            }
            Ok(_) => {}
            Err(error) => return Err(CliError::from(error)),
        }
    }
}

fn render_status(rows: &[AgentStatusRow], out: &output::Output) {
    out.list(
        ["WORKTREE", "AGENT", "STATUS", "TAB"],
        rows,
        |row| {
            [
                row.worktree_id.clone(),
                row.agent.clone(),
                row.status.clone(),
                row.tab_id.clone(),
            ]
        },
        &rows,
    );
}

fn status_wire(status: pragma_protocol::AgentStatus) -> String {
    match status {
        pragma_protocol::AgentStatus::Running => "running".to_string(),
        pragma_protocol::AgentStatus::Attention => "attention".to_string(),
        pragma_protocol::AgentStatus::Done => "done".to_string(),
        pragma_protocol::AgentStatus::Cleared => "cleared".to_string(),
    }
}

fn attention_wire(kind: pragma_protocol::AgentAttentionKind) -> String {
    match kind {
        pragma_protocol::AgentAttentionKind::Question => "question".to_string(),
        pragma_protocol::AgentAttentionKind::Command => "command".to_string(),
    }
}

fn subscribe_agents_request() -> RequestFrame {
    RequestFrame {
        request_id: Uuid::new_v4().to_string(),
        kind: RequestKind::SubscribeAgents,
        session_id: None,
        worktree_id: None,
        cwd: None,
        cols: None,
        rows: None,
        data: None,
        rpc: None,
        subscription: None,
        control: None,
        control_result: None,
    }
}

// -------------------------- agent report --------------------------

/// Status report sent by an external agent through the server. The reporting
/// logic is unchanged from the old top-level form; only the command path moved
/// under `agent report --agent <id> ...`.
pub fn agent_report(
    args: &crate::cli::AgentReportArgs,
    out: &output::Output,
) -> Result<(), CliError> {
    let tab_id = env("PRAGMA_TAB_ID").map_err(CliError::config)?;
    let (status, attention_kind, worktree_override) = report_fields(&args.report);
    let worktree_id = report_worktree(worktree_override)?;
    let payload = serde_json::json!({
        "agent": args.agent,
        "worktreeId": worktree_id,
        "tabId": tab_id,
        "status": status,
        "attentionKind": attention_kind,
    });
    let frame = RequestFrame {
        request_id: format!("agent-{}", std::process::id()),
        kind: RequestKind::AgentReport,
        session_id: None,
        worktree_id: None,
        cwd: None,
        cols: None,
        rows: None,
        data: Some(payload.to_string()),
        rpc: None,
        subscription: None,
        control: None,
        control_result: None,
    };
    let Server { mut stream } = server::connect()?;
    write_json_frame(&mut stream, &frame)?;
    // Reporting does not wait for an ack (unchanged behavior).
    out.line(
        "reported",
        &serde_json::json!({ "ok": true, "agent": args.agent }),
    );
    let _ = std::io::stdout().flush();
    Ok(())
}

/// Rich message sent by an external agent through the server.
pub fn agent_message(
    args: &crate::cli::AgentMessageArgs,
    out: &output::Output,
) -> Result<(), CliError> {
    let tab_id = env("PRAGMA_TAB_ID").map_err(CliError::config)?;
    let worktree_id = report_worktree(None)?;
    let raw = message_payload(args)?;
    let mut value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| CliError::config(format!("invalid AgentMessage JSON: {error}")))?;
    let Some(object) = value.as_object_mut() else {
        return Err(CliError::config("AgentMessage JSON must be an object"));
    };
    object.insert(
        "agent".to_string(),
        serde_json::Value::String(args.agent.clone()),
    );
    object.insert(
        "worktreeId".to_string(),
        serde_json::Value::String(worktree_id),
    );
    object.insert("tabId".to_string(), serde_json::Value::String(tab_id));
    let frame = RequestFrame {
        request_id: format!("agent-message-{}", std::process::id()),
        kind: RequestKind::AgentMessage,
        session_id: None,
        worktree_id: None,
        cwd: None,
        cols: None,
        rows: None,
        data: Some(value.to_string()),
        rpc: None,
        subscription: None,
        control: None,
        control_result: None,
    };
    let Server { mut stream } = server::connect()?;
    write_json_frame(&mut stream, &frame)?;
    out.line(
        "reported",
        &serde_json::json!({ "ok": true, "agent": args.agent, "messageId": value["id"] }),
    );
    let _ = std::io::stdout().flush();
    Ok(())
}

fn message_payload(args: &crate::cli::AgentMessageArgs) -> Result<String, CliError> {
    if let Some(payload) = &args.payload {
        return Ok(payload.clone());
    }
    if args.stdin {
        let mut payload = String::new();
        std::io::stdin().read_to_string(&mut payload)?;
        return Ok(payload);
    }
    Err(CliError::config("pass --payload JSON or --stdin"))
}

fn report_fields(
    report: &crate::cli::AgentReportCommand,
) -> (&'static str, Option<&'static str>, Option<String>) {
    match report {
        crate::cli::AgentReportCommand::Started => ("running", None, None),
        crate::cli::AgentReportCommand::Stopped { worktree_id } => {
            ("done", None, worktree_id.clone())
        }
        crate::cli::AgentReportCommand::Attention { kind } => (
            "attention",
            kind.map(|k| match k {
                crate::cli::AttentionKindArg::Question => "question",
                crate::cli::AttentionKindArg::Command => "command",
            }),
            None,
        ),
        crate::cli::AgentReportCommand::Cleared { worktree_id } => {
            ("cleared", None, worktree_id.clone())
        }
    }
}

fn report_worktree(override_id: Option<String>) -> Result<String, CliError> {
    if let Some(id) = override_id {
        return Ok(id);
    }
    env("PRAGMA_WORKTREE_ID").map_err(CliError::config)
}

/// Best-effort: keep the watch stream alive a bit so a fast Ctrl-C still flushes.
#[allow(dead_code)]
pub(crate) fn watch_grace() -> Duration {
    Duration::from_millis(50)
}
