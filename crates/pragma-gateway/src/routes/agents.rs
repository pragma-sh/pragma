use pragma_protocol::{
    AgentAnswer, AgentDecision, AgentInput, AgentInterrupt, AgentMessage, AgentReportPayload,
};
use tiny_http::Request;

use crate::error::GatewayResult;
use crate::http::response::empty_response;
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

/// Handles `POST /v1/agents/decisions`.
pub fn decision(
    request: &mut Request,
    state: &AppState,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    let payload: AgentDecision = read_json(request)?;
    state.client.report_agent_decision(&payload)?;
    Ok(empty_response(202))
}

/// Handles `POST /v1/agents/answers`.
pub fn answer(
    request: &mut Request,
    state: &AppState,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    let payload: AgentAnswer = read_json(request)?;
    state.client.report_agent_answer(&payload)?;
    Ok(empty_response(202))
}

/// Handles `POST /v1/agents/inputs`.
pub fn input(
    request: &mut Request,
    state: &AppState,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    let payload: AgentInput = read_json(request)?;
    state.client.report_agent_input(&payload)?;
    Ok(empty_response(202))
}

/// Handles `POST /v1/agents/interrupts`.
pub fn interrupt(
    request: &mut Request,
    state: &AppState,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    let payload: AgentInterrupt = read_json(request)?;
    state.client.report_agent_interrupt(&payload)?;
    Ok(empty_response(202))
}

/// Handles `GET /v1/agents/catalog`.
pub fn catalog(state: &AppState) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    let catalog = state.client.agent_catalog()?;
    crate::http::response::json_response(200, &catalog)
}

/// Handles `GET /v1/agents/events`.
pub fn events(request: Request, state: &AppState) -> GatewayResult<()> {
    let stream = state.client.subscribe_agents_stream()?;
    crate::http::response::stream_ndjson_response(request, stream)
}

/// Handles `POST /v1/tabs/{tabId}/agents/seen`.
pub fn mark_seen(
    state: &AppState,
    matched: &RouteMatch,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    state.client.mark_agents_seen(param(matched, "tabId")?)?;
    Ok(empty_response(204))
}
