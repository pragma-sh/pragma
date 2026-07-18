//! Shared RPC helpers for host-owned Pragma business logic.

use pragma_constants::{ProtocolErrorCode, ProtocolRpcMethod};

use crate::CoreError;

/// Maps core errors onto protocol-level error codes.
#[must_use]
pub fn protocol_error_code(error: &CoreError) -> ProtocolErrorCode {
    match error {
        CoreError::InvalidPayload(_) => ProtocolErrorCode::InvalidPayload,
        CoreError::StaleWrite => ProtocolErrorCode::StaleWrite,
        CoreError::NotFound(_) => ProtocolErrorCode::NotFound,
        CoreError::UnsupportedMethod(_) => ProtocolErrorCode::UnsupportedMethod,
        CoreError::Operation(_) => ProtocolErrorCode::Internal,
    }
}

/// Returns the stable wire name for a protocol RPC method.
#[must_use]
pub fn method_name(method: ProtocolRpcMethod) -> &'static str {
    match method {
        ProtocolRpcMethod::Git => "git",
        ProtocolRpcMethod::Filesystem => "filesystem",
        ProtocolRpcMethod::Database => "database",
        ProtocolRpcMethod::Kanban => "kanban",
        ProtocolRpcMethod::Worktrees => "worktrees",
        ProtocolRpcMethod::Projects => "projects",
        ProtocolRpcMethod::Tabs => "tabs",
        ProtocolRpcMethod::Settings => "settings",
        ProtocolRpcMethod::Github => "github",
        ProtocolRpcMethod::Ai => "ai",
        ProtocolRpcMethod::Exec => "exec",
        ProtocolRpcMethod::Automations => "automations",
        ProtocolRpcMethod::Plugins => "plugins",
        ProtocolRpcMethod::Tunnel => "tunnel",
        ProtocolRpcMethod::Ports => "ports",
    }
}
