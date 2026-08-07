//! `GET /v1/scratchpads?root=<absolute worktree root>` — every managed
//! scratchpad in a worktree, MDX source and attached agent included.
//!
//! Listing and frontmatter parsing belong to the host that owns the files
//! (`pragma_core::scratchpads`), so a remote client renders exactly what the
//! desktop does. This route only validates the root and forwards.

use pragma_constants::ProtocolRpcMethod;
use serde_json::json;
use tiny_http::Response;

use crate::error::{GatewayError, GatewayResult};
use crate::http::response::json_response;
use crate::http::router::RouteMatch;
use crate::http::AppState;

/// Handles `GET /v1/scratchpads`.
pub fn list(
    state: &AppState,
    matched: &RouteMatch,
) -> GatewayResult<Response<std::io::Cursor<Vec<u8>>>> {
    let root = matched
        .query
        .get("root")
        .ok_or_else(|| GatewayError::InvalidPayload("root is required".to_string()))?;
    if !std::path::Path::new(root).is_absolute() {
        return Err(GatewayError::InvalidPayload(
            "root must be an absolute path".to_string(),
        ));
    }
    let response = state.client.rpc(
        ProtocolRpcMethod::Scratchpads,
        json!({ "op": "list", "root": root }),
    )?;
    json_response(200, &response)
}
