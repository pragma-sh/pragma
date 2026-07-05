use pragma_protocol::{AgentMessage, AgentReportPayload};
use tiny_http::Request;

use crate::error::GatewayResult;
use crate::http::response::{empty_response, ndjson_response};
use crate::http::router::RouteMatch;
use crate::http::{read_json, AppState};

use super::param;

/// Handles `POST /v1/agents/reports`.
pub fn report(
    request: &mut Request,
    state: &AppState,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    let payload: AgentReportPayload = read_json(request)?;
    state.client.report_agent(&payload)?;
    Ok(empty_response(202))
}

/// Handles `POST /v1/agents/messages`.
pub fn message(
    request: &mut Request,
    state: &AppState,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    let payload: AgentMessage = read_json(request)?;
    state.client.report_agent_message(&payload)?;
    Ok(empty_response(202))
}

/// Handles `GET /v1/agents/events`.
pub fn events(
    state: &AppState,
) -> GatewayResult<tiny_http::Response<crate::http::response::NdjsonReader>> {
    Ok(ndjson_response(state.client.subscribe_agents_stream()?))
}

/// Handles `POST /v1/tabs/{tabId}/agents/seen`.
pub fn mark_seen(
    state: &AppState,
    matched: &RouteMatch,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    state.client.mark_agents_seen(param(matched, "tabId")?)?;
    Ok(empty_response(204))
}
