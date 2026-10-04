//! Thin account-provider adapter: every call is forwarded to the host that owns
//! the project, which owns the logins, the bindings, and the sign-in terminals.
//! Accounts are per host, so a remote project's accounts live on that host.

use pragma_constants::ProtocolRpcMethod;
use serde_json::{json, Value};
use tauri::State;

use crate::db::Db;
use crate::error::AppResult;
use crate::hosts::Hosts;

/// Forwards one `accounts` RPC to a project's owning host, or to this machine
/// when no project is selected. A request without `projectRoot` gets the
/// project's host path, so project overrides resolve against the right root.
#[tauri::command(async)]
pub fn accounts_rpc(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    project_id: Option<String>,
    mut payload: Value,
) -> AppResult<Value> {
    let Some(project_id) = project_id else {
        return hosts.local().rpc(ProtocolRpcMethod::Accounts, payload);
    };
    if payload.get("projectRoot").map_or(true, Value::is_null) {
        payload["projectRoot"] = Value::String(db.project(&project_id)?.path);
    }
    hosts
        .for_project(&db, &project_id)?
        .rpc(ProtocolRpcMethod::Accounts, payload)
}

/// Env a launch of `agent_id` into `worktree_id` needs for its bound accounts,
/// recorded against `tab_id` on the owning host.
#[tauri::command(async)]
pub fn accounts_launch_env(
    db: State<'_, Db>,
    hosts: State<'_, Hosts>,
    worktree_id: String,
    agent_id: String,
    tab_id: String,
) -> AppResult<Value> {
    let worktree = db.worktree(&worktree_id)?;
    let project = db.project(&worktree.project_id)?;
    let client = hosts.for_project(&db, &project.id)?;
    client.rpc(
        ProtocolRpcMethod::Accounts,
        json!({
            "action": "launchEnv",
            "agentId": agent_id,
            "projectRoot": project.path,
            "tabId": tab_id,
        }),
    )
}
