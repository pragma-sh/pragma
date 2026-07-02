use serde::Serialize;

use crate::error::GatewayResult;
use crate::http::response::json_response;
use crate::http::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthBody {
    status: &'static str,
    protocol_version: u64,
    gateway_version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionBody {
    gateway_version: &'static str,
    protocol_version: u64,
}

/// Handles `GET /v1/health`.
pub fn health(state: &AppState) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    json_response(
        200,
        &HealthBody {
            status: "ok",
            protocol_version: state.client.protocol_version(),
            gateway_version: state.gateway_version,
        },
    )
}

/// Handles `GET /v1/version`.
pub fn version(state: &AppState) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    json_response(
        200,
        &VersionBody {
            gateway_version: state.gateway_version,
            protocol_version: state.client.protocol_version(),
        },
    )
}
