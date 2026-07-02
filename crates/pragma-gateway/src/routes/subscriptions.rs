use pragma_constants::ProtocolEventKind;

use crate::error::{GatewayError, GatewayResult};
use crate::http::response::ndjson_response;
use crate::http::router::RouteMatch;
use crate::http::AppState;

use super::param;

/// Handles `GET /v1/subscriptions/{event}`.
pub fn events(
    state: &AppState,
    matched: &RouteMatch,
) -> GatewayResult<tiny_http::Response<crate::http::response::NdjsonReader>> {
    let event = parse_event(&param(matched, "event")?).ok_or(GatewayError::NotFound)?;
    let worktree_id = matched.query.get("worktreeId").cloned();
    let cwd = matched.query.get("cwd").cloned();
    Ok(ndjson_response(state.client.subscribe_stream(
        event,
        worktree_id,
        cwd,
    )?))
}

fn parse_event(event: &str) -> Option<ProtocolEventKind> {
    Some(match event {
        "agentStatus" => ProtocolEventKind::AgentStatus,
        "worktreeChanged" => ProtocolEventKind::WorktreeChanged,
        "kanbanChanged" => ProtocolEventKind::KanbanChanged,
        "tabsChanged" => ProtocolEventKind::TabsChanged,
        "fileChanged" => ProtocolEventKind::FileChanged,
        "echoMode" => ProtocolEventKind::EchoMode,
        _ => return None,
    })
}
