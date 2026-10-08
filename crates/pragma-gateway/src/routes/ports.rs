use pragma_constants::{PortForwardRequest, PortForwardResult};
use tiny_http::Request;

use crate::error::GatewayResult;
use crate::http::response::json_response;
use crate::http::{read_json, AppState};

/// Starts a verified design-injected port forward.
pub fn forward(
    request: &mut Request,
    state: &AppState,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    let payload: PortForwardRequest = read_json(request)?;
    let result: PortForwardResult = state.port_forwards.forward(payload, &state.client)?;
    json_response(200, &result)
}
