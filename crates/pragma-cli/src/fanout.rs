//! `pragma-cli fanout` — direct-to-server fanout orchestration.
//!
//! Every command here speaks the `fanouts` RPC on the host socket rather than
//! the desktop broker, so a fanout created from an agent's own terminal behaves
//! the same whether Pragma is open or closed.
//!
//! The CLI's only extra job over the shared contract is defaulting: the
//! positional prompt, `$PRAGMA_WORKTREE_ID`, `$PRAGMA_FANOUT_ID`, and
//! `$PRAGMA_FANOUT_MEMBER_ID` are resolved here and the request that leaves is
//! the same one `@pragma/sdk` sends.

use std::io::{IsTerminal, Write};

use pragma_constants::{ProtocolEventKind, ProtocolRpcMethod, CONSTANTS};
use pragma_protocol::{
    read_json_frame, write_json_frame, EventFrame, RequestFrame, RequestKind, ResponseFrame,
    RpcRequest, RpcResponseFrame, ServerFrame, SubscriptionRequest,
};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::cli::{
    FanoutCreateArgs, FanoutMemberArgs, FanoutPickArgs, FanoutReadArgs, FanoutRefArgs,
    FanoutSendArgs, FanoutShowArgs,
};
use crate::output::Output;
use crate::server::{self, read_stdin, CliError, Server};

/// Runs one fanout command.
pub fn run(command: &crate::cli::FanoutCommand, out: &Output) -> Result<(), CliError> {
    use crate::cli::FanoutCommand;
    match command {
        FanoutCommand::Create(args) => create(args, out),
        FanoutCommand::Show(args) => show(args, out),
        FanoutCommand::Read(args) => read(args, out),
        FanoutCommand::Send(args) => send(args, out),
        FanoutCommand::Retry(args) => retry(args, out),
        FanoutCommand::Cancel(args) => cancel(args, out),
        FanoutCommand::Pick(args) => pick(args, out),
    }
}

// -------------------------------------------------------------------- create

fn create(args: &FanoutCreateArgs, out: &Output) -> Result<(), CliError> {
    let prompt = prompt_text(args)?;
    if args.agents.len() < 2 {
        return Err(CliError::config(
            "a fanout needs at least two --agent selectors",
        ));
    }
    let parent = parent_spec(args)?;
    let project_id = project_id_for(&parent_worktree(args)?)?;
    let payload = json!({
        "action": "create",
        "projectId": project_id,
        "parent": parent,
        "prompt": prompt,
        "defaultReasoningId": args.reasoning,
        "members": args
            .agents
            .iter()
            .map(|selector| json!({ "selector": selector }))
            .collect::<Vec<_>>(),
        "jobs": args.jobs,
        "idempotencyKey": args.idempotency_key,
    });
    let result = rpc(payload)?;
    render_fanout(&result["fanout"], out);
    // A partly-provisioned fanout still returns its persisted members, but the
    // exit status has to say something went wrong or a script would march on.
    if result["partial"].as_bool() == Some(true) {
        for failure in result["failures"].as_array().into_iter().flatten() {
            eprintln!(
                "error: {} ({})",
                failure["message"].as_str().unwrap_or_default(),
                failure["code"].as_str().unwrap_or_default()
            );
        }
        return Err(CliError::server("some attempts failed to launch"));
    }
    Ok(())
}

/// The shared prompt: positional, `--prompt-file <path>`, or stdin via `-`.
fn prompt_text(args: &FanoutCreateArgs) -> Result<String, CliError> {
    let prompt = match (&args.prompt, &args.prompt_file) {
        (Some(prompt), None) => prompt.clone(),
        (None, Some(path)) if path == "-" => read_stdin()?,
        (None, Some(path)) => std::fs::read_to_string(path)
            .map_err(|error| CliError::config(format!("read {path}: {error}")))?,
        (None, None) => return Err(CliError::config("pass a prompt, or --prompt-file <path|->")),
        (Some(_), Some(_)) => {
            return Err(CliError::config(
                "pass either a positional prompt or --prompt-file, not both",
            ))
        }
    };
    if prompt.trim().is_empty() {
        return Err(CliError::config("the prompt is empty"));
    }
    Ok(prompt)
}

/// The parent spec: an existing worktree, or a new coordination worktree.
fn parent_spec(args: &FanoutCreateArgs) -> Result<Value, CliError> {
    match &args.new_parent {
        Some(branch) => {
            let source = server::worktree_id(args.from.clone())?;
            Ok(json!({
                "kind": "new",
                "sourceWorktreeId": source,
                "branch": branch,
                "title": args.parent_title,
            }))
        }
        None => Ok(json!({
            "kind": "existing",
            "worktreeId": server::worktree_id(args.parent.clone())?,
        })),
    }
}

/// The worktree the create request is anchored to, for project resolution.
fn parent_worktree(args: &FanoutCreateArgs) -> Result<String, CliError> {
    if args.new_parent.is_some() {
        server::worktree_id(args.from.clone())
    } else {
        server::worktree_id(args.parent.clone())
    }
}

/// The project a worktree belongs to, read from the host's workspace mirror.
///
/// The CLI has no database of its own, and the caller should not have to name
/// a project id it can only learn from the app.
fn project_id_for(worktree_id: &str) -> Result<String, CliError> {
    let Server { mut stream } = server::connect()?;
    let request = RequestFrame {
        request_id: Uuid::new_v4().to_string(),
        kind: RequestKind::Subscribe,
        session_id: None,
        worktree_id: None,
        cwd: None,
        cols: None,
        rows: None,
        data: None,
        shell: None,
        rpc: None,
        subscription: Some(SubscriptionRequest {
            event: ProtocolEventKind::Workspace,
            cursor: None,
        }),
        control: None,
        control_result: None,
    };
    write_json_frame(&mut stream, &request)?;
    loop {
        match read_json_frame::<ServerFrame>(&mut stream)? {
            ServerFrame::Event(EventFrame::Snapshot { payload, .. }) => {
                return payload["worktrees"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|worktree| worktree["id"] == worktree_id)
                    .and_then(|worktree| worktree["projectId"].as_str())
                    .map(str::to_string)
                    .ok_or_else(|| {
                        CliError::config(format!(
                            "worktree {worktree_id} is not in the host's workspace"
                        ))
                    });
            }
            ServerFrame::Response(ResponseFrame {
                ok: false, error, ..
            }) => {
                return Err(CliError::server(
                    error.unwrap_or_else(|| "workspace subscription rejected".to_string()),
                ));
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------- show

fn show(args: &FanoutShowArgs, out: &Output) -> Result<(), CliError> {
    let fanout = rpc(with_reference(json!({ "action": "get" }), &args.reference)?)?;
    render_fanout(&fanout, out);
    if args.watch {
        watch(fanout["id"].as_str().unwrap_or_default(), out)?;
    }
    Ok(())
}

/// Streams fanout snapshots until the connection ends or Ctrl-C.
fn watch(fanout_id: &str, out: &Output) -> Result<(), CliError> {
    let Server { mut stream } = server::connect()?;
    let request = RequestFrame {
        request_id: Uuid::new_v4().to_string(),
        kind: RequestKind::Subscribe,
        session_id: None,
        worktree_id: None,
        cwd: None,
        cols: None,
        rows: None,
        data: None,
        shell: None,
        rpc: None,
        subscription: Some(SubscriptionRequest {
            event: ProtocolEventKind::Fanouts,
            cursor: None,
        }),
        control: None,
        control_result: None,
    };
    write_json_frame(&mut stream, &request)?;
    // A subscription is mostly idle; leaving the connect-time read timeout on
    // would make every quiet interval look like a dropped stream.
    let _ = stream.set_read_timeout(None);
    loop {
        let frame = read_json_frame::<ServerFrame>(&mut stream)?;
        // The snapshot was already rendered by the caller's `get`.
        let ServerFrame::Event(EventFrame::Delta { payload, .. }) = frame else {
            continue;
        };
        let Some(fanout) = payload["fanouts"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|fanout| fanout["id"] == fanout_id)
        else {
            continue;
        };
        render_fanout(fanout, out);
    }
}

// ---------------------------------------------------------------------- read

fn read(args: &FanoutReadArgs, out: &Output) -> Result<(), CliError> {
    let member = member_id(args.member.clone(), !args.all)?;
    let mut payload = with_reference(json!({ "action": "read" }), &args.reference)?;
    payload["memberId"] = json!(member);
    payload["all"] = json!(args.all);
    payload["lines"] = json!(args.lines);
    let result = rpc(payload)?;
    if out.is_structured() {
        out.line("", &result);
        return Ok(());
    }
    for target in result["targets"].as_array().into_iter().flatten() {
        println!(
            "── {} · {} · tab {}",
            target["memberId"].as_str().unwrap_or_default(),
            target["runtimeAgentId"].as_str().unwrap_or_default(),
            target["tabId"].as_str().unwrap_or_default()
        );
        println!("{}", target["text"].as_str().unwrap_or_default());
    }
    Ok(())
}

// ---------------------------------------------------------------------- send

fn send(args: &FanoutSendArgs, out: &Output) -> Result<(), CliError> {
    let message = match (&args.message, &args.message_file) {
        (Some(message), None) => message.clone(),
        (None, Some(path)) if path == "-" => read_stdin()?,
        (None, Some(path)) => std::fs::read_to_string(path)
            .map_err(|error| CliError::config(format!("read {path}: {error}")))?,
        _ => {
            return Err(CliError::config(
                "pass --message <text> or --message-file <path|->",
            ))
        }
    };
    let target = if args.all {
        json!({ "kind": "all" })
    } else {
        json!({
            "kind": "member",
            "memberId": member_id(args.member.clone(), true)?
                .ok_or_else(|| CliError::config("pass --member <id>"))?,
        })
    };
    let mut payload = with_reference(json!({ "action": "send" }), &args.reference)?;
    payload["target"] = target;
    payload["message"] = json!(message);
    payload["messageId"] = json!(args.message_id);
    payload["waitForDelivery"] = json!(!args.no_wait);
    let result = rpc(payload)?;
    let receipts: Vec<Receipt> = serde_json::from_value(result["receipts"].clone())?;
    out.list(
        ["MEMBER", "AGENT", "TAB", "DELIVERY"],
        &receipts,
        |receipt| {
            [
                receipt.member_id.clone(),
                receipt.runtime_agent_id.clone(),
                receipt.tab_id.clone(),
                receipt.state.clone(),
            ]
        },
        &result,
    );
    if receipts
        .iter()
        .any(|receipt| receipt.state == "failed" || receipt.state == "timedOut")
    {
        return Err(CliError::server("some members did not take the follow-up"));
    }
    Ok(())
}

#[derive(Debug, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    member_id: String,
    tab_id: String,
    runtime_agent_id: String,
    state: String,
}

// ------------------------------------------------------------ retry / cancel

fn retry(args: &FanoutMemberArgs, out: &Output) -> Result<(), CliError> {
    let mut payload = with_reference(json!({ "action": "retry" }), &args.reference)?;
    payload["memberId"] = json!(member_id(args.member.clone(), true)?
        .ok_or_else(|| CliError::config("pass --member <id>"))?);
    let result = rpc(payload)?;
    render_fanout(&result["fanout"], out);
    Ok(())
}

fn cancel(args: &FanoutRefArgs, out: &Output) -> Result<(), CliError> {
    let result = rpc(with_reference(json!({ "action": "cancel" }), args)?)?;
    render_fanout(&result["fanout"], out);
    Ok(())
}

// ---------------------------------------------------------------------- pick

fn pick(args: &FanoutPickArgs, out: &Output) -> Result<(), CliError> {
    let member = member_id(args.member.member.clone(), true)?
        .ok_or_else(|| CliError::config("pass --member <id>"))?;
    let fanout = rpc(with_reference(
        json!({ "action": "get" }),
        &args.member.reference,
    )?)?;
    if !args.yes {
        confirm(&fanout, &member)?;
    }
    let mut payload = with_reference(json!({ "action": "pick" }), &args.member.reference)?;
    payload["memberId"] = json!(member);
    let result = rpc(payload)?;
    if out.is_structured() {
        out.line("", &result);
    } else {
        println!(
            "picked {member} · stage {}",
            result["stage"].as_str().unwrap_or_default()
        );
        for path in result["promotedScratchpads"]
            .as_array()
            .into_iter()
            .flatten()
        {
            println!("promoted {}", path.as_str().unwrap_or_default());
        }
        for id in result["deletedWorktreeIds"]
            .as_array()
            .into_iter()
            .flatten()
        {
            println!("deleted worktree {}", id.as_str().unwrap_or_default());
        }
    }
    let survivors = result["survivingWorktreeIds"]
        .as_array()
        .is_some_and(|ids| !ids.is_empty());
    if survivors {
        for id in result["survivingWorktreeIds"]
            .as_array()
            .into_iter()
            .flatten()
        {
            eprintln!(
                "error: could not delete worktree {}",
                id.as_str().unwrap_or_default()
            );
        }
        return Err(CliError::server(
            "cleanup did not finish; rerun `fanout pick` to retry the remaining deletions",
        ));
    }
    for failure in result["failures"].as_array().into_iter().flatten() {
        eprintln!("error: {}", failure["message"].as_str().unwrap_or_default());
    }
    if result["stage"].as_str() != Some("completed") {
        return Err(CliError::server(
            "finalization stopped before completing; resolve the reported problem and rerun",
        ));
    }
    Ok(())
}

/// Prints exactly what a pick will destroy, then requires a typed `yes`.
///
/// Not a yes/no prompt on a whim: this deletes every attempt worktree, branch,
/// and session in the fanout, and there is no undo.
fn confirm(fanout: &Value, member_id: &str) -> Result<(), CliError> {
    if !std::io::stdin().is_terminal() {
        return Err(CliError::config(
            "`fanout pick` is destructive; pass --yes to run it without a terminal",
        ));
    }
    let empty = Vec::new();
    let members = fanout["members"].as_array().unwrap_or(&empty);
    let winner = members
        .iter()
        .find(|member| member["id"] == member_id)
        .ok_or_else(|| CliError::config(format!("no member {member_id} in this fanout")))?;
    println!(
        "Pick {} ({}{}) as the implementation of `{}`.",
        member_id,
        winner["catalogAgentId"].as_str().unwrap_or_default(),
        winner["modelId"]
            .as_str()
            .map(|model| format!(" · {model}"))
            .unwrap_or_default(),
        fanout["title"].as_str().unwrap_or_default()
    );
    println!(
        "  merges into parent worktree {}, promotes its scratchpads, then deletes every attempt (winner included):",
        fanout["parentWorktreeId"].as_str().unwrap_or_default()
    );
    for member in members {
        println!(
            "    {} · worktree {} · branch {} · tab {}",
            member["id"].as_str().unwrap_or_default(),
            member["worktreeId"].as_str().unwrap_or("—"),
            member["branch"].as_str().unwrap_or_default(),
            member["tabId"].as_str().unwrap_or("—")
        );
    }
    println!("Winner's uncommitted work is committed with an AI-generated message; a merge conflict stops before deletion.");
    print!("Type `yes` to continue: ");
    let _ = std::io::stdout().flush();
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .map_err(|error| CliError::config(error.to_string()))?;
    if answer.trim() != "yes" {
        return Err(CliError::config("cancelled"));
    }
    Ok(())
}

// ----------------------------------------------------------------- internals

/// Fills in the fanout reference: an explicit id, then `$PRAGMA_FANOUT_ID`,
/// then the current worktree (which resolves as a parent or as an attempt).
fn with_reference(mut payload: Value, reference: &FanoutRefArgs) -> Result<Value, CliError> {
    let fanout_id = reference
        .fanout
        .clone()
        .or_else(|| server::env(&CONSTANTS.fanout.env_fanout_id).ok());
    if let Some(id) = fanout_id {
        payload["fanoutId"] = json!(id);
    } else {
        let worktree = server::optional_worktree_id(None).ok_or_else(|| {
            CliError::config("pass a fanout id, or run inside a fanout parent or attempt worktree")
        })?;
        payload["worktreeId"] = json!(worktree);
    }
    Ok(payload)
}

/// Resolves the member a command acts on, defaulting to the member of the
/// session the command is running in.
fn member_id(explicit: Option<String>, required: bool) -> Result<Option<String>, CliError> {
    let member = explicit.or_else(|| server::env(&CONSTANTS.fanout.env_member_id).ok());
    if member.is_none() && required {
        return Err(CliError::config(
            "pass --member <id> (or run inside a fanout attempt)",
        ));
    }
    Ok(member)
}

/// Sends one `fanouts` RPC and returns its payload.
fn rpc(payload: Value) -> Result<Value, CliError> {
    let Server { mut stream } = server::connect()?;
    let request_id = Uuid::new_v4().to_string();
    let request = RequestFrame {
        request_id: request_id.clone(),
        kind: RequestKind::Rpc,
        session_id: None,
        worktree_id: None,
        cwd: None,
        cols: None,
        rows: None,
        data: None,
        shell: None,
        rpc: Some(RpcRequest {
            method: ProtocolRpcMethod::Fanouts,
            payload,
        }),
        subscription: None,
        control: None,
        control_result: None,
    };
    write_json_frame(&mut stream, &request)?;
    // Provisioning creates worktrees, runs setup scripts, and starts TUIs; none
    // of that fits inside the connect-time read timeout.
    let _ = stream.set_read_timeout(None);
    loop {
        match read_json_frame::<ServerFrame>(&mut stream)? {
            ServerFrame::Rpc(RpcResponseFrame {
                request_id: id,
                ok,
                payload,
                error,
            }) if id == request_id => {
                if ok {
                    return Ok(payload.unwrap_or(Value::Null));
                }
                let error = error.ok_or_else(|| CliError::server("fanout request failed"))?;
                return Err(CliError::server(format!(
                    "{} ({})",
                    error.message,
                    error
                        .details
                        .as_ref()
                        .and_then(|details| details["code"].as_str())
                        .unwrap_or("error")
                )));
            }
            _ => {}
        }
    }
}

/// Renders a fanout as an aligned member table, or the whole durable object
/// under `--json`/`--toon`.
fn render_fanout(fanout: &Value, out: &Output) {
    if out.is_structured() {
        out.line("", fanout);
        return;
    }
    println!(
        "{} · {} · base {}",
        fanout["title"].as_str().unwrap_or_default(),
        fanout["status"].as_str().unwrap_or_default(),
        short(fanout["baseCommit"].as_str().unwrap_or_default())
    );
    let empty = Vec::new();
    let members: Vec<Row> = fanout["members"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .map(Row::from_member)
        .collect();
    out.list(
        [
            "MEMBER",
            "AGENT",
            "MODEL",
            "REASONING",
            "STATUS",
            "WORKTREE",
            "TAB",
        ],
        &members,
        |row| {
            [
                row.member.clone(),
                row.agent.clone(),
                row.model.clone(),
                row.reasoning.clone(),
                row.status.clone(),
                row.worktree.clone(),
                row.tab.clone(),
            ]
        },
        &members,
    );
}

#[derive(Debug, Serialize)]
struct Row {
    member: String,
    agent: String,
    model: String,
    reasoning: String,
    status: String,
    worktree: String,
    tab: String,
}

impl Row {
    fn from_member(member: &Value) -> Self {
        Self {
            member: member["id"].as_str().unwrap_or_default().to_string(),
            agent: member["catalogAgentId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            model: member["modelId"].as_str().unwrap_or("—").to_string(),
            reasoning: member["reasoningId"].as_str().unwrap_or("auto").to_string(),
            status: member["status"].as_str().unwrap_or_default().to_string(),
            worktree: member["worktreeId"].as_str().unwrap_or("—").to_string(),
            tab: member["tabId"].as_str().unwrap_or("—").to_string(),
        }
    }
}

/// Short form of a commit hash for the text table.
fn short(value: &str) -> String {
    value.chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::short;

    #[test]
    fn commit_hashes_are_shortened_for_the_text_table() {
        assert_eq!(short("aaaa1111bbbb2222"), "aaaa1111");
        assert_eq!(short("abc"), "abc");
    }
}
