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
    let mut payload: Value = read_json(request)?;
    if method == ProtocolRpcMethod::Computer {
        // Gateway credentials never convey desktop-user authority. In particular,
        // an SDK caller cannot approve itself by supplying caller.kind = user.
        let object = payload.as_object_mut().ok_or_else(|| {
            GatewayError::InvalidPayload("computer request must be an object".to_string())
        })?;
        let caller = object.get("caller");
        let attributed = caller.filter(|caller| caller["kind"] == "agentTab")
            .and_then(|caller| caller["tabId"].as_str().map(|tab| serde_json::json!({"kind":"agentTab","tabId":tab,"worktreeId":caller["worktreeId"]})))
            .unwrap_or_else(||serde_json::json!({"kind":"sdk"}));
        // Agent ids are resolved on the host; user/plugin authority is never accepted.
        object.insert("caller".to_string(), attributed);
    }
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
        "scratchpads" => ProtocolRpcMethod::Scratchpads,
        "whiteboards" => ProtocolRpcMethod::Whiteboards,
        "fanouts" => ProtocolRpcMethod::Fanouts,
        "sessions" => ProtocolRpcMethod::Sessions,
        "scripts" => ProtocolRpcMethod::Scripts,
        "ports" => ProtocolRpcMethod::Ports,
        "accounts" => ProtocolRpcMethod::Accounts,
        "computer" => ProtocolRpcMethod::Computer,
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
            parse_method("sessions"),
            Some(ProtocolRpcMethod::Sessions)
        ));
        assert!(matches!(
            parse_method("plugins"),
            Some(ProtocolRpcMethod::Plugins)
        ));
        assert!(matches!(
            parse_method("fanouts"),
            Some(ProtocolRpcMethod::Fanouts)
        ));
        assert!(matches!(
            parse_method("ports"),
            Some(ProtocolRpcMethod::Ports)
        ));
        assert!(parse_method("tunnel").is_none(), "desktop-only control");
        assert!(matches!(
            parse_method("whiteboards"),
            Some(ProtocolRpcMethod::Whiteboards)
        ));
        assert!(matches!(
            parse_method("accounts"),
            Some(ProtocolRpcMethod::Accounts)
        ));
        assert!(parse_method("missing").is_none());
    }
}
