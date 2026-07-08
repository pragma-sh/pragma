use std::io;

use pragma_client::ClientError;
use pragma_constants::ProtocolErrorCode;
use serde::Serialize;
use thiserror::Error;

/// Gateway result type.
pub type GatewayResult<T> = Result<T, GatewayError>;

/// Errors surfaced by the HTTP gateway.
#[derive(Debug, Error)]
pub enum GatewayError {
    /// Request body or route payload was invalid.
    #[error("invalid payload: {0}")]
    InvalidPayload(String),
    /// Bearer token was missing or invalid.
    #[error("unauthorized")]
    Unauthorized,
    /// Route or RPC method was not found.
    #[error("not found")]
    NotFound,
    /// No desktop controller is registered; the remote caller can render
    /// "Open Pragma on your computer to launch sessions."
    #[error("pragma is not running: {0}")]
    Conflict(String),
    /// Server and gateway protocol versions differ.
    #[error("protocol version mismatch: expected {expected}, actual {actual}")]
    ProtocolMismatch { expected: u64, actual: u64 },
    /// Socket transport failed.
    #[error("transport failure: {0}")]
    Transport(String),
    /// I/O failed.
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    /// JSON serialization or parsing failed.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    /// HTTP server failed.
    #[error("http error: {0}")]
    Http(String),
    /// Server returned a protocol-level RPC error.
    #[error("rpc error {code:?}: {message}")]
    Rpc {
        code: ProtocolErrorCode,
        message: String,
    },
    /// Server rejected a non-RPC request.
    #[error("server error: {0}")]
    Server(String),
}

impl GatewayError {
    /// HTTP status code for this error.
    #[must_use]
    pub fn status(&self) -> u16 {
        match self {
            Self::InvalidPayload(_) | Self::Json(_) => 400,
            Self::Unauthorized => 401,
            Self::NotFound => 404,
            Self::Conflict(_) => 409,
            Self::ProtocolMismatch { .. } => 503,
            Self::Transport(_) => 502,
            Self::Rpc { code, .. } => rpc_status(*code),
            Self::Server(_) | Self::Io(_) | Self::Http(_) => 500,
        }
    }

    /// Stable gateway error code.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidPayload(_) | Self::Json(_) => "invalidPayload",
            Self::Unauthorized => "unauthorized",
            Self::NotFound => "notFound",
            Self::Conflict(_) => "conflict",
            Self::ProtocolMismatch { .. } => "protocolVersionMismatch",
            Self::Transport(_) => "transport",
            Self::Rpc { code, .. } => protocol_code_name(*code),
            Self::Server(_) | Self::Io(_) | Self::Http(_) => "internal",
        }
    }
}

impl From<ClientError> for GatewayError {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::Io(err) => Self::Transport(err.to_string()),
            ClientError::Protocol(err) => Self::Transport(err.to_string()),
            ClientError::Server(message) => {
                // The canonical "app not running" reply from a brokered
                // control request becomes 409 so a phone can render "Open Pragma
                // on your computer to launch sessions." rather than a 500.
                if message.contains("Pragma is not running") {
                    Self::Conflict(message)
                } else {
                    Self::Server(message)
                }
            }
            ClientError::Rpc { code, message } => Self::Rpc { code, message },
            ClientError::LockPoisoned => Self::Server("client lock poisoned".to_string()),
            ClientError::NoBootstrap => {
                Self::Transport("server socket is not reachable".to_string())
            }
        }
    }
}

/// JSON error envelope returned by failed routes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    /// Stable error code.
    pub code: &'static str,
    /// Human-readable message.
    pub message: String,
}

impl From<&GatewayError> for ErrorBody {
    fn from(error: &GatewayError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

fn rpc_status(code: ProtocolErrorCode) -> u16 {
    match code {
        ProtocolErrorCode::InvalidPayload => 400,
        ProtocolErrorCode::UnsupportedMethod => 501,
        ProtocolErrorCode::NotFound => 404,
        ProtocolErrorCode::StaleWrite => 409,
        ProtocolErrorCode::PermissionDenied => 403,
        ProtocolErrorCode::Internal => 500,
    }
}

fn protocol_code_name(code: ProtocolErrorCode) -> &'static str {
    match code {
        ProtocolErrorCode::InvalidPayload => "invalidPayload",
        ProtocolErrorCode::UnsupportedMethod => "unsupportedMethod",
        ProtocolErrorCode::NotFound => "notFound",
        ProtocolErrorCode::StaleWrite => "staleWrite",
        ProtocolErrorCode::PermissionDenied => "permissionDenied",
        ProtocolErrorCode::Internal => "internal",
    }
}

#[cfg(test)]
mod tests {
    use pragma_constants::ProtocolErrorCode;

    use super::GatewayError;

    #[test]
    fn maps_rpc_errors_to_http_statuses() {
        let cases = [
            (ProtocolErrorCode::InvalidPayload, 400),
            (ProtocolErrorCode::UnsupportedMethod, 501),
            (ProtocolErrorCode::NotFound, 404),
            (ProtocolErrorCode::StaleWrite, 409),
            (ProtocolErrorCode::PermissionDenied, 403),
            (ProtocolErrorCode::Internal, 500),
        ];
        for (code, status) in cases {
            let error = GatewayError::Rpc {
                code,
                message: "failed".to_string(),
            };
            assert_eq!(error.status(), status);
        }
    }
}
