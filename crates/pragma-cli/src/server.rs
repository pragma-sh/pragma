//! Shared connection + environment helpers for talking to `pragma-server`.
//!
//! The CLI reads `PRAGMA_SERVER_SOCKET` (falling back to the legacy
//! `PRAGMA_DAEMON_SOCKET`), connects to the Unix socket, reads the `Hello`
//! frame, and verifies the protocol version. `--worktree` defaults to
//! `$PRAGMA_WORKTREE_ID` everywhere it is optional.

use pragma_platform::ipc::{self, LocalStream};

use pragma_constants::CONSTANTS;
use pragma_protocol::{read_json_frame, HelloFrame, ProtocolError, ServerFrame};

/// Resolves the server socket path from the environment.
pub fn socket_path() -> Result<String, String> {
    env_any(["PRAGMA_SERVER_SOCKET", "PRAGMA_DAEMON_SOCKET"])
}

/// Resolves the `--worktree` value, defaulting to `$PRAGMA_WORKTREE_ID`.
pub fn worktree_id(override_id: Option<String>) -> Result<String, CliError> {
    if let Some(id) = override_id {
        return Ok(id);
    }
    env("PRAGMA_WORKTREE_ID").map_err(CliError::config)
}

/// Resolves the `--worktree` value, returning `None` when neither the override
/// nor the env var is set (e.g. for `tab list --all` or `agent status` with no
/// worktree filter).
pub fn optional_worktree_id(override_id: Option<String>) -> Option<String> {
    override_id.or_else(|| {
        std::env::var("PRAGMA_WORKTREE_ID")
            .ok()
            .filter(|v| !v.is_empty())
    })
}

/// A connected, hello-verified server stream.
pub struct Server {
    pub stream: LocalStream,
}

/// Connects to the server, reads the hello frame, and verifies the protocol
/// version. Returns a stream ready to send requests.
pub fn connect() -> Result<Server, CliError> {
    let path = socket_path().map_err(CliError::config)?;
    let mut stream = ipc::connect(std::path::Path::new(&path))
        .map_err(|e| CliError::config(format!("connect to {path}: {e}")))?;
    let expected = CONSTANTS.daemon.protocol_version.get();
    match read_json_frame::<ServerFrame>(&mut stream) {
        Ok(ServerFrame::Hello(HelloFrame { protocol_version })) if protocol_version == expected => {
        }
        Ok(ServerFrame::Hello(HelloFrame { protocol_version })) => {
            return Err(CliError::Config(format!(
                "server protocol mismatch: expected {expected}, got {protocol_version}"
            )));
        }
        Ok(
            ServerFrame::Response(_)
            | ServerFrame::Event(_)
            | ServerFrame::Rpc(_)
            | ServerFrame::Control(_)
            | ServerFrame::ControlResult(_),
        ) => {
            return Err(CliError::Config(
                "server did not send hello frame".to_string(),
            ));
        }
        Err(error) => return Err(CliError::Protocol(error)),
    }
    Ok(Server { stream })
}

/// Errors surfaced by connection setup and direct-to-server reads.
#[derive(Debug)]
pub enum CliError {
    /// A configuration/environment problem (missing env, socket connect,
    /// protocol mismatch). Printed without the "error:" operation prefix so it
    /// reads as a setup failure rather than a server reply.
    Config(String),
    /// A wire-protocol I/O or framing error.
    Protocol(ProtocolError),
    /// A server reply reported an error string.
    Server(String),
    /// An app-not-running broker reply (distinct so scripts can branch).
    AppNotRunning,
    /// Any other operational error.
    Other(String),
}

impl CliError {
    pub fn config(message: impl Into<String>) -> Self {
        Self::Config(message.into())
    }
    pub fn server(message: impl Into<String>) -> Self {
        Self::Server(message.into())
    }
    pub fn other(message: impl Into<String>) -> Self {
        Self::Other(message.into())
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Protocol(error) => write!(f, "{error}"),
            Self::AppNotRunning => f.write_str("Pragma is not running. Launch the app first."),
            Self::Config(message) | Self::Server(message) | Self::Other(message) => {
                f.write_str(message)
            }
        }
    }
}

impl From<ProtocolError> for CliError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

impl From<std::io::Error> for CliError {
    fn from(error: std::io::Error) -> Self {
        Self::Protocol(error.into())
    }
}

impl From<serde_json::Error> for CliError {
    fn from(error: serde_json::Error) -> Self {
        Self::Protocol(error.into())
    }
}

pub fn env(name: &str) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing {name}"))
}

pub fn env_any<const N: usize>(names: [&str; N]) -> Result<String, String> {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
        .ok_or_else(|| format!("missing one of {}", names.join(", ")))
}

/// Reads stdin fully as a UTF-8 string (used for `split set --layout -` and
/// `browser exec -`).
pub fn read_stdin() -> Result<String, CliError> {
    use std::io::Read;
    let mut buf = String::new();
    match std::io::stdin().read_to_string(&mut buf) {
        Ok(_) => Ok(buf),
        Err(error) => Err(CliError::from(error)),
    }
}
