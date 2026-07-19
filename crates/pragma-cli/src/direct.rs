//! Direct-to-server readers that do not need the running app:
//! - `tab read` — attach to a session, collect replayed scrollback frames,
//!   optionally stay attached and stream new output (`--watch`).
//! - `agent status` — subscribe to agents, print the snapshot, optionally
//!   keep the subscription open and print deltas (`--watch`).
//! - `agent report` — write one `AgentReport` frame and exit (unchanged
//!   logic, only the command path moved).

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use pragma_protocol::{
    read_frame, read_json_frame, write_json_frame, EventFrame, Frame, ProtocolError, RequestFrame,
    RequestKind, ResponseFrame, ServerFrame,
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

/// How long `agent status` waits for additional snapshot rows after the
/// subscribe ack before deciding the server's stored-status burst is done.
/// Separate from `tab read`'s [`READ_TIMEOUT`] so the two drains can be tuned
/// independently (a snapshot with many registered agents may need longer).
const AGENT_SNAPSHOT_TIMEOUT: Duration = READ_TIMEOUT;

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
    // The server acks the subscription *before* streaming the stored-status
    // snapshot, so breaking on the ack would always render an empty table.
    // Read up to the ack first, then drain the snapshot until a short idle
    // gap marks it complete (the snapshot has no end-of-list delimiter).
    loop {
        match read_json_frame::<ServerFrame>(&mut stream) {
            Ok(ServerFrame::Event(event)) => {
                if let Some(row) = agent_row(event) {
                    rows.push(row);
                }
            }
            Ok(ServerFrame::Response(ResponseFrame { ok, error, .. })) => {
                if !ok {
                    return Err(CliError::server(
                        error.unwrap_or_else(|| "agent subscription rejected".to_string()),
                    ));
                }
                break;
            }
            Ok(_) => {}
            Err(error) => return Err(CliError::from(error)),
        }
    }
    let _ = stream.set_read_timeout(Some(AGENT_SNAPSHOT_TIMEOUT));
    loop {
        match read_json_frame::<ServerFrame>(&mut stream) {
            Ok(ServerFrame::Event(event)) => {
                if let Some(row) = agent_row(event) {
                    rows.push(row);
                }
            }
            Ok(_) => {}
            Err(ProtocolError::Io(ref e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                // Idle gap: the snapshot is fully delivered.
                break;
            }
            // A real I/O or protocol error mid-drain (e.g. the server hung up):
            // surface it instead of silently rendering a truncated table.
            Err(error) => return Err(CliError::from(error)),
        }
    }
    render_status(&rows, out);
    if args.watch {
        let _ = stream.set_read_timeout(None);
        stream_deltas(&mut stream, args, out)?;
    }
    Ok(())
}

/// Converts an agent status event into a printable row; `None` for other events.
fn agent_row(event: EventFrame) -> Option<AgentStatusRow> {
    if let EventFrame::Agent {
        worktree_id,
        tab_id,
        agent,
        status,
        attention_kind,
        ..
    } = event
    {
        Some(AgentStatusRow {
            worktree_id,
            tab_id,
            agent,
            status: status_wire(status),
            attention_kind: attention_kind.map(attention_wire),
        })
    } else {
        None
    }
}

fn stream_deltas(
    stream: &mut UnixStream,
    args: &crate::cli::AgentStatusArgs,
    out: &output::Output,
) -> Result<(), CliError> {
    loop {
        match read_json_frame::<ServerFrame>(stream) {
            Ok(ServerFrame::Event(event)) => {
                let Some(row) = agent_row(event) else {
                    continue;
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
    let fields = report_fields(&args.report);
    let worktree_id = report_worktree(fields.worktree_override)?;
    let mut payload = serde_json::json!({
        "agent": args.agent,
        "worktreeId": worktree_id,
        "tabId": tab_id,
        "status": fields.status,
        "attentionKind": fields.attention_kind,
        "command": fields.command,
        "question": fields.question,
        "requestId": fields.request_id,
    });
    // `options` deserializes into a plain Vec server-side, so the key must be
    // absent (not null) when no choices were passed.
    if let Some(raw) = &fields.options {
        payload["options"] = parse_question_options(raw)?;
    }
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

/// Blocks on the agent event stream until a matching [`AgentDecision`] arrives,
/// printing `allow`/`deny` on stdout. Used by a blocking harness hook to turn a
/// remote approval toast into a synchronous permission verdict. Times out (exit
/// non-zero, no output) after `--timeout` seconds so the caller can fall back.
pub fn agent_await_decision(args: &crate::cli::AgentAwaitDecisionArgs) -> Result<(), CliError> {
    let Server { mut stream } = server::connect()?;
    let request = subscribe_agents_request();
    write_json_frame(&mut stream, &request)?;
    let deadline = (args.timeout > 0).then(|| Instant::now() + Duration::from_secs(args.timeout));
    loop {
        if let Some(deadline) = deadline {
            match deadline.checked_duration_since(Instant::now()) {
                Some(remaining) => {
                    let _ = stream.set_read_timeout(Some(remaining.max(Duration::from_millis(1))));
                }
                None => return Err(CliError::config("timed out waiting for approval decision")),
            }
        }
        match read_json_frame::<ServerFrame>(&mut stream) {
            Ok(ServerFrame::Event(EventFrame::AgentDecision { decision }))
                if decision.request_id == args.request_id && decision.agent == args.agent =>
            {
                println!("{}", if decision.approved { "allow" } else { "deny" });
                let _ = std::io::stdout().flush();
                return Ok(());
            }
            Ok(_) => {}
            Err(pragma_protocol::ProtocolError::Io(ref error))
                if deadline.is_some()
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
            {
                return Err(CliError::config("timed out waiting for approval decision"));
            }
            Err(error) => return Err(CliError::from(error)),
        }
    }
}

/// Publishes a command-approval verdict, fanned out to the waiting reporter.
pub fn agent_decide(
    args: &crate::cli::AgentDecideArgs,
    out: &output::Output,
) -> Result<(), CliError> {
    if !args.allow && !args.deny {
        return Err(CliError::config("pass --allow or --deny"));
    }
    let tab_id = env("PRAGMA_TAB_ID").map_err(CliError::config)?;
    let worktree_id = report_worktree(None)?;
    let payload = serde_json::json!({
        "agent": args.agent,
        "worktreeId": worktree_id,
        "tabId": tab_id,
        "requestId": args.request_id,
        "approved": args.allow,
    });
    publish_agent_frame(RequestKind::AgentDecision, &payload)?;
    out.line(
        "decided",
        &serde_json::json!({
            "ok": true,
            "agent": args.agent,
            "requestId": args.request_id,
            "approved": args.allow,
        }),
    );
    let _ = std::io::stdout().flush();
    Ok(())
}

/// Publishes a reply to a question request, fanned out to the waiting reporter.
pub fn agent_answer(
    args: &crate::cli::AgentAnswerPublishArgs,
    out: &output::Output,
) -> Result<(), CliError> {
    if args.text.is_none() && !args.dismiss {
        return Err(CliError::config("pass --text <answer> or --dismiss"));
    }
    let tab_id = env("PRAGMA_TAB_ID").map_err(CliError::config)?;
    let worktree_id = report_worktree(None)?;
    let payload = serde_json::json!({
        "agent": args.agent,
        "worktreeId": worktree_id,
        "tabId": tab_id,
        "requestId": args.request_id,
        "answer": args.text,
        "dismissed": args.dismiss,
    });
    publish_agent_frame(RequestKind::AgentAnswer, &payload)?;
    out.line(
        "answered",
        &serde_json::json!({
            "ok": true,
            "agent": args.agent,
            "requestId": args.request_id,
            "dismissed": args.dismiss,
        }),
    );
    let _ = std::io::stdout().flush();
    Ok(())
}

/// Publishes a free-form interjection, fanned out to the waiting reporter.
pub fn agent_input(
    args: &crate::cli::AgentInputArgs,
    out: &output::Output,
) -> Result<(), CliError> {
    let tab_id = env("PRAGMA_TAB_ID").map_err(CliError::config)?;
    let worktree_id = report_worktree(None)?;
    let payload = serde_json::json!({
        "agent": args.agent,
        "worktreeId": worktree_id,
        "tabId": tab_id,
        "text": args.text,
        "requestId": args.request_id,
    });
    publish_agent_frame(RequestKind::AgentInput, &payload)?;
    out.line(
        "sent",
        &serde_json::json!({
            "ok": true,
            "agent": args.agent,
        }),
    );
    let _ = std::io::stdout().flush();
    Ok(())
}

/// Writes one fire-and-forget agent publish frame (decision, answer, or input).
fn publish_agent_frame(kind: RequestKind, payload: &serde_json::Value) -> Result<(), CliError> {
    let frame = RequestFrame {
        request_id: format!("agent-publish-{}", std::process::id()),
        kind,
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
    Ok(())
}

/// Blocks on the agent event stream until a matching [`AgentAnswer`] arrives,
/// printing the reply text on stdout. Used by a blocking harness hook to turn a
/// remote question toast into a synchronous answer. A timeout exits non-zero
/// with no output so the caller can fall back. Dismissal does the same unless
/// `--dismiss-output` gives a blocking hook an explicit cancellation marker.
pub fn agent_await_answer(args: &crate::cli::AgentAwaitAnswerArgs) -> Result<(), CliError> {
    let Server { mut stream } = server::connect()?;
    let request = subscribe_agents_request();
    write_json_frame(&mut stream, &request)?;
    let deadline = (args.timeout > 0).then(|| Instant::now() + Duration::from_secs(args.timeout));
    loop {
        if let Some(deadline) = deadline {
            match deadline.checked_duration_since(Instant::now()) {
                Some(remaining) => {
                    let _ = stream.set_read_timeout(Some(remaining.max(Duration::from_millis(1))));
                }
                None => return Err(CliError::config("timed out waiting for question answer")),
            }
        }
        match read_json_frame::<ServerFrame>(&mut stream) {
            Ok(ServerFrame::Event(EventFrame::AgentAnswer { answer }))
                if answer.request_id == args.request_id && answer.agent == args.agent =>
            {
                if answer.dismissed {
                    if let Some(output) = &args.dismiss_output {
                        println!("{output}");
                        let _ = std::io::stdout().flush();
                        return Ok(());
                    }
                    return Err(CliError::config("question dismissed without an answer"));
                }
                println!("{}", answer.answer.unwrap_or_default());
                let _ = std::io::stdout().flush();
                return Ok(());
            }
            Ok(_) => {}
            Err(pragma_protocol::ProtocolError::Io(ref error))
                if deadline.is_some()
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
            {
                return Err(CliError::config("timed out waiting for question answer"));
            }
            Err(error) => return Err(CliError::from(error)),
        }
    }
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

/// The wire fields derived from a `report` subcommand.
struct ReportFields {
    status: &'static str,
    attention_kind: Option<&'static str>,
    command: Option<String>,
    question: Option<String>,
    options: Option<String>,
    request_id: Option<String>,
    worktree_override: Option<String>,
}

/// Parses the `--options` JSON into validated [`pragma_protocol::QuestionOption`]s.
fn parse_question_options(raw: &str) -> Result<serde_json::Value, CliError> {
    let options: Vec<pragma_protocol::QuestionOption> = serde_json::from_str(raw)
        .map_err(|err| CliError::config(format!("invalid --options JSON: {err}")))?;
    serde_json::to_value(options).map_err(|err| CliError::config(err.to_string()))
}

fn report_fields(report: &crate::cli::AgentReportCommand) -> ReportFields {
    match report {
        crate::cli::AgentReportCommand::Started => ReportFields {
            status: "running",
            attention_kind: None,
            command: None,
            question: None,
            options: None,
            request_id: None,
            worktree_override: None,
        },
        crate::cli::AgentReportCommand::Stopped { worktree_id } => ReportFields {
            status: "done",
            attention_kind: None,
            command: None,
            question: None,
            options: None,
            request_id: None,
            worktree_override: worktree_id.clone(),
        },
        crate::cli::AgentReportCommand::Attention {
            kind,
            command,
            question,
            options,
            request_id,
        } => ReportFields {
            status: "attention",
            attention_kind: kind.map(|k| match k {
                crate::cli::AttentionKindArg::Question => "question",
                crate::cli::AttentionKindArg::Command => "command",
            }),
            command: command.clone(),
            question: question.clone(),
            options: options.clone(),
            request_id: request_id.clone(),
            worktree_override: None,
        },
        crate::cli::AgentReportCommand::Cleared { worktree_id } => ReportFields {
            status: "cleared",
            attention_kind: None,
            command: None,
            question: None,
            options: None,
            request_id: None,
            worktree_override: worktree_id.clone(),
        },
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

#[cfg(test)]
mod tests {
    use super::parse_question_options;

    #[test]
    fn parses_valid_question_options() {
        let value =
            parse_question_options(r#"[{"label":"Yes","description":"Do it"},{"label":"No"}]"#)
                .expect("valid options JSON parses");
        let options = value.as_array().expect("options serialize as an array");
        assert_eq!(options.len(), 2);
        assert_eq!(options[0]["label"], "Yes");
        assert_eq!(options[0]["description"], "Do it");
        assert_eq!(options[1]["label"], "No");
    }

    #[test]
    fn rejects_malformed_question_options() {
        assert!(parse_question_options("not json").is_err());
        assert!(parse_question_options(r#"[{"description":"missing label"}]"#).is_err());
    }
}
