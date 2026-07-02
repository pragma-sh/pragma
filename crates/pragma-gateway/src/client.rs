use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use pragma_client::PragmaClient;
use pragma_constants::{ProtocolEventKind, ProtocolRpcMethod, CONSTANTS};
use pragma_protocol::AgentReportPayload;
use serde_json::Value;

use crate::error::{GatewayError, GatewayResult};

/// Shared gateway client wrapper that enforces protocol compatibility.
#[derive(Clone)]
pub struct GatewayClient {
    client: PragmaClient,
    expected_protocol_version: u64,
}

impl GatewayClient {
    /// Creates a gateway client for an existing Unix socket.
    #[must_use]
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            client: PragmaClient::new_socket(socket_path),
            expected_protocol_version: CONSTANTS.daemon.protocol_version.get(),
        }
    }

    /// Expected protocol version.
    #[must_use]
    pub fn protocol_version(&self) -> u64 {
        self.expected_protocol_version
    }

    /// Verifies the upstream server speaks the expected protocol.
    pub fn ensure_protocol(&self) -> GatewayResult<()> {
        let actual = self
            .client
            .server_protocol_version()
            .map_err(GatewayError::from)?;
        if actual == self.expected_protocol_version {
            Ok(())
        } else {
            Err(GatewayError::ProtocolMismatch {
                expected: self.expected_protocol_version,
                actual,
            })
        }
    }

    /// Sends an RPC request.
    pub fn rpc(&self, method: ProtocolRpcMethod, payload: Value) -> GatewayResult<Value> {
        self.ensure_protocol()?;
        self.client.rpc(method, payload).map_err(GatewayError::from)
    }

    /// Spawns a session and returns its event stream.
    pub fn spawn_stream(
        &self,
        session_id: String,
        worktree_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> GatewayResult<UnixStream> {
        self.ensure_protocol()?;
        self.client
            .spawn_stream(session_id, worktree_id, cwd, cols, rows)
            .map_err(GatewayError::from)
    }

    /// Attaches to a session event stream.
    pub fn attach_stream(
        &self,
        session_id: String,
        cols: u16,
        rows: u16,
    ) -> GatewayResult<UnixStream> {
        self.ensure_protocol()?;
        self.client
            .attach_stream(session_id, cols, rows)
            .map_err(GatewayError::from)
    }

    /// Writes raw bytes to a session.
    pub fn write(&self, session_id: String, data: Vec<u8>) -> GatewayResult<()> {
        self.ensure_protocol()?;
        self.client
            .write(session_id, data)
            .map_err(GatewayError::from)
    }

    /// Resizes a session.
    pub fn resize(&self, session_id: String, cols: u16, rows: u16) -> GatewayResult<()> {
        self.ensure_protocol()?;
        self.client
            .resize(session_id, cols, rows)
            .map_err(GatewayError::from)
    }

    /// Kills a session.
    pub fn kill(&self, session_id: String) -> GatewayResult<()> {
        self.ensure_protocol()?;
        self.client.kill(session_id).map_err(GatewayError::from)
    }

    /// Kills sessions for a cwd.
    pub fn kill_for_cwd(&self, cwd: String) -> GatewayResult<()> {
        self.ensure_protocol()?;
        self.client.kill_for_cwd(cwd).map_err(GatewayError::from)
    }

    /// Reports an agent status.
    pub fn report_agent(&self, payload: &AgentReportPayload) -> GatewayResult<()> {
        self.ensure_protocol()?;
        self.client
            .report_agent(payload)
            .map_err(GatewayError::from)
    }

    /// Opens the agent event stream.
    pub fn subscribe_agents_stream(&self) -> GatewayResult<UnixStream> {
        self.ensure_protocol()?;
        self.client
            .subscribe_agents_stream()
            .map_err(GatewayError::from)
    }

    /// Marks a tab's done agents as seen.
    pub fn mark_agents_seen(&self, tab_id: String) -> GatewayResult<()> {
        self.ensure_protocol()?;
        self.client
            .mark_agents_seen(tab_id)
            .map_err(GatewayError::from)
    }

    /// Opens a protocol subscription stream.
    pub fn subscribe_stream(
        &self,
        event: ProtocolEventKind,
        worktree_id: Option<String>,
        cwd: Option<String>,
    ) -> GatewayResult<UnixStream> {
        self.ensure_protocol()?;
        self.client
            .subscribe_stream(event, worktree_id, cwd)
            .map_err(GatewayError::from)
    }
}
