use pragma_constants::ProtocolRpcMethod;
use serde_json::Value;
use tiny_http::Request;

use crate::error::{GatewayError, GatewayResult};
use crate::http::response::json_response;
use crate::http::router::RouteMatch;
use crate::http::{read_json, AppState};

use super::param;

/// Handles `POST /v1/rpc/{method}`.
pub fn rpc(
    request: &mut Request,
    state: &AppState,
    matched: &RouteMatch,
) -> GatewayResult<tiny_http::Response<std::io::Cursor<Vec<u8>>>> {
    let method = parse_method(&param(matched, "method")?).ok_or(GatewayError::NotFound)?;
    let payload: Value = read_json(request)?;
    let response = state.client.rpc(method, payload)?;
    json_response(200, &response)
}

fn parse_method(method: &str) -> Option<ProtocolRpcMethod> {
    Some(match method {
        "git" => ProtocolRpcMethod::Git,
        "filesystem" => ProtocolRpcMethod::Filesystem,
        "database" => ProtocolRpcMethod::Database,
        "kanban" => ProtocolRpcMethod::Kanban,
        "worktrees" => ProtocolRpcMethod::Worktrees,
        "projects" => ProtocolRpcMethod::Projects,
        "tabs" => ProtocolRpcMethod::Tabs,
        "settings" => ProtocolRpcMethod::Settings,
        "github" => ProtocolRpcMethod::Github,
        "ai" => ProtocolRpcMethod::Ai,
        "exec" => ProtocolRpcMethod::Exec,
        "automations" => ProtocolRpcMethod::Automations,
        "plugins" => ProtocolRpcMethod::Plugins,
        "tunnel" => ProtocolRpcMethod::Tunnel,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use pragma_constants::ProtocolRpcMethod;

    use super::parse_method;

    #[test]
    fn validates_rpc_methods() {
        assert!(matches!(
            parse_method("filesystem"),
            Some(ProtocolRpcMethod::Filesystem)
        ));
        assert!(matches!(
            parse_method("plugins"),
            Some(ProtocolRpcMethod::Plugins)
        ));
        assert!(parse_method("missing").is_none());
    }
}
