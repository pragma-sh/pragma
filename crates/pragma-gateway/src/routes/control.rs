use pragma_constants::ControlMethod;
use serde_json::Value;
use tiny_http::Request;

use crate::error::{GatewayError, GatewayResult};
use crate::http::response::json_response;
use crate::http::router::RouteMatch;
use crate::http::{read_json, AppState};

use super::param;

/// Handles `POST /v1/control/{method}` — a thin allowlist over the brokered
/// control protocol. The server forwards the request to the running desktop
/// app (the single controller); when no controller is registered the caller
/// gets a 409 so the phone can render "Open Pragma on your computer to launch
/// sessions."
pub fn control(
    request: &mut Request,
    state: &AppState,
    matched: &RouteMatch,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    let method = parse_method(&param(matched, "method")?).ok_or(GatewayError::NotFound)?;
    let payload: Value = read_json(request)?;
    let response = state.client.control(method, payload)?;
    json_response(200, &response)
}

/// Parses the allowed control methods from the URL path. V1 allows only
/// `agentSessionLaunch`; other methods stay on the CLI's direct socket path.
fn parse_method(method: &str) -> Option<ControlMethod> {
    Some(match method {
        "agentSessionLaunch" => ControlMethod::AgentSessionLaunch,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use pragma_constants::ControlMethod;

    use super::parse_method;

    #[test]
    fn validates_allowed_control_methods() {
        assert!(matches!(
            parse_method("agentSessionLaunch"),
            Some(ControlMethod::AgentSessionLaunch)
        ));
        assert!(parse_method("agentStart").is_none(), "not allowlisted");
        assert!(parse_method("missing").is_none());
    }
}
