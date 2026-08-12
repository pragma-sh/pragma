use pragma_constants::ProtocolEventKind;
use tiny_http::Request;

use crate::error::{GatewayError, GatewayResult};
use crate::http::response::stream_ndjson_response;
use crate::http::router::RouteMatch;
use crate::http::AppState;

use super::param;

/// Handles `GET /v1/subscriptions/{event}`.
pub fn events(request: Request, state: &AppState, matched: &RouteMatch) -> GatewayResult<()> {
    let event = parse_event(&param(matched, "event")?).ok_or(GatewayError::NotFound)?;
    let worktree_id = matched.query.get("worktreeId").cloned();
    let cwd = matched.query.get("cwd").cloned();
    let stream = state.client.subscribe_stream(event, worktree_id, cwd)?;
    stream_ndjson_response(request, stream)
}

fn parse_event(event: &str) -> Option<ProtocolEventKind> {
    Some(match event {
        "agentStatus" => ProtocolEventKind::AgentStatus,
        "worktreeChanged" => ProtocolEventKind::WorktreeChanged,
        "kanbanChanged" => ProtocolEventKind::KanbanChanged,
        "tabsChanged" => ProtocolEventKind::TabsChanged,
        "fileChanged" => ProtocolEventKind::FileChanged,
        "echoMode" => ProtocolEventKind::EchoMode,
        "automationPending" => ProtocolEventKind::AutomationPending,
        "automationsChanged" => ProtocolEventKind::AutomationsChanged,
        "workspace" => ProtocolEventKind::Workspace,
        "fanouts" => ProtocolEventKind::Fanouts,
        _ => return None,
    })
}
