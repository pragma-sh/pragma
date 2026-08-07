//! Host-side business logic boundary for Pragma.
//!
//! This crate is intentionally free of Tauri dependencies. The desktop app can
//! call it in-process during the local-only transition, and `pragma-server` can
//! own the same logic behind the Unix-socket RPC surface as the architecture
//! moves remote-first.

use serde_json::Value;
use thiserror::Error;

use pragma_constants::ProtocolRpcMethod;

pub mod exec;
pub mod fs;
pub mod git;
pub mod process_env;
pub mod rpc;
pub mod scratchpads;
pub mod tabs;
pub mod watcher;

/// Result type for host-side core operations.
pub type CoreResult<T> = Result<T, CoreError>;

/// Errors returned by pure core operations before they are mapped onto IPC/RPC.
#[derive(Debug, Error)]
pub enum CoreError {
    /// The requested RPC method is part of the protocol but not yet implemented
    /// by the host core router.
    #[error("unsupported RPC method: {0}")]
    UnsupportedMethod(String),
    /// The client sent a payload that does not match the method contract.
    #[error("invalid payload: {0}")]
    InvalidPayload(String),
    /// The request is stale relative to the host's authoritative state version.
    #[error("stale write")]
    StaleWrite,
    /// The requested host resource does not exist.
    #[error("not found: {0}")]
    NotFound(String),
    /// A lower-level operation failed.
    #[error("operation failed: {0}")]
    Operation(String),
}

impl From<std::io::Error> for CoreError {
    fn from(error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::NotFound {
            Self::NotFound(error.to_string())
        } else {
            Self::Operation(error.to_string())
        }
    }
}

/// Minimal core router used by `pragma-server` for generalized RPC traffic.
///
/// Business modules are moved behind this seam incrementally. Until a method is
/// implemented, the router returns a typed unsupported-method error instead of
/// letting server protocol code grow ad-hoc dispatch branches.
#[derive(Default)]
pub struct Core;

impl Core {
    /// Handles one JSON RPC payload and returns a JSON response payload.
    ///
    /// Path-based domains (`filesystem`, `git`) execute against the host's own
    /// filesystem using the trusted absolute root carried in the payload, so the
    /// same code serves a local project and an SSH-bridged remote one. Metadata
    /// domains remain client-local for now and return an unsupported-method error.
    pub fn handle_rpc(&self, method: ProtocolRpcMethod, payload: Value) -> CoreResult<Value> {
        match method {
            ProtocolRpcMethod::Filesystem => fs::handle(payload),
            ProtocolRpcMethod::Git => git::handle(payload),
            ProtocolRpcMethod::Exec => exec::handle(payload),
            ProtocolRpcMethod::Scratchpads => scratchpads::handle(payload),
            ProtocolRpcMethod::Database
            | ProtocolRpcMethod::Kanban
            | ProtocolRpcMethod::Worktrees
            | ProtocolRpcMethod::Projects
            | ProtocolRpcMethod::Tabs
            | ProtocolRpcMethod::Settings
            | ProtocolRpcMethod::Github
            | ProtocolRpcMethod::Ai
            | ProtocolRpcMethod::Automations
            | ProtocolRpcMethod::Plugins
            | ProtocolRpcMethod::Tunnel
            | ProtocolRpcMethod::Ports => Err(CoreError::UnsupportedMethod(
                rpc::method_name(method).to_string(),
            )),
        }
    }
}
