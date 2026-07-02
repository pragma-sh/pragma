use serde::{Deserialize, Serialize};
use tiny_http::Request;
use uuid::Uuid;

use crate::error::{GatewayError, GatewayResult};
use crate::http::response::{empty_response, json_response, ndjson_response};
use crate::http::router::RouteMatch;
use crate::http::{read_body, read_json, AppState};

use super::param;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    cwd: String,
    #[serde(default)]
    worktree_id: Option<String>,
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpawnResponse {
    session_id: String,
    worktree_id: String,
    cwd: String,
}

#[derive(Deserialize)]
struct ResizeRequest {
    cols: u16,
    rows: u16,
}

#[derive(Serialize)]
struct KillForCwdResponse {
    killed: u8,
}

/// Handles `POST /v1/sessions`.
pub fn spawn(
    request: &mut Request,
    state: &AppState,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    let payload: SpawnRequest = read_json(request)?;
    if payload.cwd.trim().is_empty() {
        return Err(GatewayError::InvalidPayload("cwd is required".to_string()));
    }
    let session_id = Uuid::new_v4().to_string();
    let worktree_id = payload.worktree_id.unwrap_or_else(|| session_id.clone());
    let _stream = state.client.spawn_stream(
        session_id.clone(),
        worktree_id.clone(),
        payload.cwd.clone(),
        payload.cols,
        payload.rows,
    )?;
    json_response(
        201,
        &SpawnResponse {
            session_id,
            worktree_id,
            cwd: payload.cwd,
        },
    )
}

/// Handles `GET /v1/sessions/{id}/events`.
pub fn events(
    state: &AppState,
    matched: &RouteMatch,
) -> GatewayResult<tiny_http::Response<crate::http::response::NdjsonReader>> {
    let session_id = param(matched, "id")?;
    let cols = matched
        .query
        .get("cols")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or_else(default_cols);
    let rows = matched
        .query
        .get("rows")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or_else(default_rows);
    Ok(ndjson_response(
        state.client.attach_stream(session_id, cols, rows)?,
    ))
}

/// Handles `POST /v1/sessions/{id}/input`.
pub fn input(
    request: &mut Request,
    state: &AppState,
    matched: &RouteMatch,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    state
        .client
        .write(param(matched, "id")?, read_body(request)?)?;
    Ok(empty_response(202))
}

/// Handles `POST /v1/sessions/{id}/resize`.
pub fn resize(
    request: &mut Request,
    state: &AppState,
    matched: &RouteMatch,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    let payload: ResizeRequest = read_json(request)?;
    state
        .client
        .resize(param(matched, "id")?, payload.cols, payload.rows)?;
    Ok(empty_response(200))
}

/// Handles `DELETE /v1/sessions/{id}`.
pub fn kill(
    state: &AppState,
    matched: &RouteMatch,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    state.client.kill(param(matched, "id")?)?;
    Ok(empty_response(204))
}

/// Handles `DELETE /v1/sessions?cwd=`.
pub fn kill_for_cwd(
    state: &AppState,
    matched: &RouteMatch,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    let cwd = matched
        .query
        .get("cwd")
        .cloned()
        .ok_or_else(|| GatewayError::InvalidPayload("cwd is required".to_string()))?;
    state.client.kill_for_cwd(cwd)?;
    json_response(200, &KillForCwdResponse { killed: 0 })
}

fn default_cols() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}
