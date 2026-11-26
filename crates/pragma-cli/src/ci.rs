//! `pragma-cli ci`: read, arm, and disarm the host-owned CI watch of a worktree.

use pragma_constants::{CiWatch, CiWatchMode, CiWatchStatus, ProtocolRpcMethod, CONSTANTS};
use serde_json::{json, Value};

use crate::cli::{CiCommand, CiDisarmArgs, CiWatchArgs, CiWorktreeArgs};
use crate::output::Output;
use crate::server::{self, CliError};

/// Runs one CI watch command against the persistent host.
pub fn run(command: &CiCommand, out: &Output) -> Result<(), CliError> {
    match command {
        CiCommand::Watch(args) => watch(args, out),
        CiCommand::Status(args) => status(args, out),
        CiCommand::List => list(out),
        CiCommand::Disarm(args) => disarm(args, out),
        CiCommand::Clear(args) => clear(args, out),
    }
}

fn watch(args: &CiWatchArgs, out: &Output) -> Result<(), CliError> {
    let mode = if args.no_merge {
        CiWatchMode::Watch
    } else {
        CiWatchMode::WatchMerge
    };
    let record: CiWatch = parse(rpc(json!({
        "action": "arm",
        "worktreeId": server::worktree_id(args.worktree.clone())?,
        "mode": mode,
        "agentId": args.agent,
        "modelId": args.model,
        "reasoningId": args.reasoning,
    }))?)?;
    out.line(
        format!(
            "Armed: {} (agent {}). The Pragma app drives the watch while it is open.",
            mode_label(record.mode),
            record.agent_id
        ),
        &record,
    );
    Ok(())
}

fn status(args: &CiWorktreeArgs, out: &Output) -> Result<(), CliError> {
    let worktree_id = server::worktree_id(args.worktree.clone())?;
    let record: Option<CiWatch> = parse(rpc(json!({
        "action": "get",
        "worktreeId": worktree_id,
    }))?)?;
    match record {
        Some(record) => out.line(describe(&record), &record),
        None => out.line(
            format!("No CI watch for worktree {worktree_id}."),
            &Value::Null,
        ),
    }
    Ok(())
}

fn list(out: &Output) -> Result<(), CliError> {
    let records: Vec<CiWatch> = parse(rpc(json!({ "action": "list" }))?)?;
    out.list(
        ["WORKTREE", "MODE", "STATUS", "PR", "ATTEMPTS", "ERROR"],
        &records,
        |record| {
            [
                record.worktree_id.clone(),
                mode_label(record.mode).to_string(),
                status_label(record.status).to_string(),
                record
                    .pr_number
                    .map_or_else(|| "-".to_string(), |number| format!("#{number}")),
                attempts_label(record),
                record.error.clone().unwrap_or_default(),
            ]
        },
        &records,
    );
    Ok(())
}

fn disarm(args: &CiDisarmArgs, out: &Output) -> Result<(), CliError> {
    let record: CiWatch = parse(rpc(json!({
        "action": "disarm",
        "worktreeId": server::worktree_id(args.worktree.clone())?,
        "reason": args.reason,
    }))?)?;
    out.line(describe(&record), &record);
    Ok(())
}

fn clear(args: &CiWorktreeArgs, out: &Output) -> Result<(), CliError> {
    let worktree_id = server::worktree_id(args.worktree.clone())?;
    let result = rpc(json!({ "action": "clear", "worktreeId": worktree_id }))?;
    let cleared = result["cleared"].as_bool().unwrap_or(false);
    out.line(
        if cleared {
            format!("Cleared the CI watch for worktree {worktree_id}.")
        } else {
            format!("No CI watch for worktree {worktree_id}.")
        },
        &result,
    );
    Ok(())
}

/// A multi-line human description; the error is printed in full, never truncated.
fn describe(record: &CiWatch) -> String {
    let pr = record.pr_number.map_or_else(
        || "pull request not resolved yet".to_string(),
        |n| format!("PR #{n}"),
    );
    let mut text = format!(
        "{} · {} · {} · fix attempts {} · agent {}",
        status_label(record.status),
        mode_label(record.mode),
        pr,
        attempts_label(record),
        record.agent_id,
    );
    if let Some(error) = record.error.as_deref().filter(|error| !error.is_empty()) {
        text.push_str("\n\n");
        text.push_str(error);
    }
    text
}

fn attempts_label(record: &CiWatch) -> String {
    format!(
        "{}/{}",
        record.attempts, CONSTANTS.github.ci_watch_max_fix_attempts
    )
}

fn mode_label(mode: CiWatchMode) -> &'static str {
    match mode {
        CiWatchMode::Watch => "watch and fix",
        CiWatchMode::WatchMerge => "watch, fix, and merge",
    }
}

fn status_label(status: CiWatchStatus) -> &'static str {
    match status {
        CiWatchStatus::Watching => "watching",
        CiWatchStatus::Fixing => "fixing",
        CiWatchStatus::Merging => "merging",
        CiWatchStatus::Merged => "merged",
        CiWatchStatus::Failed => "failed",
        CiWatchStatus::Disarmed => "disarmed",
    }
}

fn rpc(payload: Value) -> Result<Value, CliError> {
    server::rpc(ProtocolRpcMethod::CiWatches, payload)
}

fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, CliError> {
    serde_json::from_value(value).map_err(|error| CliError::server(error.to_string()))
}
