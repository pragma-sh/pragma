use pragma_constants::CONSTANTS;
use serde::Serialize;

use crate::error::GatewayResult;
use crate::http::response::json_response;
use crate::http::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthBody {
    status: &'static str,
    protocol_version: String,
    gateway_version: &'static str,
    api_version: String,
}

// Every field of this body is a version — that is the whole route. The names
// are the wire contract, so the shared suffix stays.
#[allow(clippy::struct_field_names)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionBody {
    gateway_version: &'static str,
    protocol_version: String,
    api_version: String,
}

/// Handles `GET /v1/health`.
///
/// `apiVersion` is the client-facing `/v1` contract version, and this route is
/// unauthenticated — which is what lets a remote client check compatibility
/// before it stores a connection, however it was given the URL. The QR payload
/// carries the same value, but a hand-typed host has no payload to read.
pub fn health(state: &AppState) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    json_response(
        200,
        &HealthBody {
            status: "ok",
            protocol_version: state.client.protocol_version().to_string(),
            gateway_version: state.gateway_version,
            api_version: CONSTANTS.gateway.api_version.clone(),
        },
    )
}

/// Handles `GET /v1/version`.
pub fn version(state: &AppState) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    json_response(
        200,
        &VersionBody {
            gateway_version: state.gateway_version,
            protocol_version: state.client.protocol_version().to_string(),
            api_version: CONSTANTS.gateway.api_version.clone(),
        },
    )
}
