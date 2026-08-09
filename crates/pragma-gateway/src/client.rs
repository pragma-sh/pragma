use pragma_platform::ipc::LocalStream;
use std::path::PathBuf;

use pragma_client::PragmaClient;
use pragma_constants::{ProtocolEventKind, ProtocolRpcMethod, CONSTANTS};
use pragma_protocol::{
    AgentAnswer, AgentDecision, AgentInput, AgentInterrupt, AgentMessage, AgentReportPayload,
};
use serde_json::{json, Value};

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

    /// Sends a brokered control request to the desktop app and returns its
    /// JSON reply. Used by `POST /v1/control/{method}` to route remote
    /// `agentSessionLaunch` requests to the controller, or to the server's
    /// existing-worktree headless fallback when no controller is connected.
    pub fn control(
        &self,
        method: pragma_constants::ControlMethod,
        payload: Value,
    ) -> GatewayResult<Value> {
        self.ensure_protocol()?;
        self.client
            .control(method, payload)
            .map_err(GatewayError::from)
    }

    /// Returns the cached agent catalog assembled by the plugins sidecar.
    pub fn agent_catalog(&self) -> GatewayResult<Value> {
        self.rpc(ProtocolRpcMethod::Plugins, json!({ "action": "catalog" }))
    }

    /// Asks the host to re-resolve the plugin agent catalog. Called after this
    /// gateway writes its discovery file: a catalog assembled before then ran
    /// without gateway credentials and dropped agents whose model providers
    /// need them.
    pub fn reload_plugins(&self) -> GatewayResult<Value> {
        self.rpc(ProtocolRpcMethod::Plugins, json!({ "action": "reload" }))
    }

    /// Returns `{ base64, mime }` for a plugin-contributed icon asset by hash.
    pub fn read_asset(&self, hash: &str) -> GatewayResult<Value> {
        self.rpc(
            ProtocolRpcMethod::Plugins,
            json!({ "action": "readAsset", "hash": hash }),
        )
    }

    /// Returns the home directory of the host owning the socket. The global
    /// theme file hangs off it, and when the daemon is reached through an SSH
    /// bridge that path is on the remote machine — resolving it locally would
    /// read the wrong user's file, or an unrelated coincidentally matching one.
    pub fn home_dir(&self) -> GatewayResult<String> {
        let home = self.rpc(ProtocolRpcMethod::Filesystem, json!({ "op": "homeDir" }))?;
        home.as_str().map(ToString::to_string).ok_or_else(|| {
            GatewayError::InvalidPayload("homeDir response must be a string".to_string())
        })
    }

    /// Reads a UTF-8 text file that lives under `root` on the host owning the
    /// socket, returning `None` when it does not exist.
    ///
    /// Goes through the host's `filesystem` RPC rather than `std::fs` so the
    /// gateway never assumes the files it serves are on its own disk, and so
    /// path containment stays in the one place that enforces it (`pragma-core`
    /// resolves `path` inside `root` and refuses to escape it).
    pub fn read_text_file(&self, root: &str, path: &str) -> GatewayResult<Option<String>> {
        let exists = self.rpc(
            ProtocolRpcMethod::Filesystem,
            json!({ "op": "pathExists", "root": root, "path": path }),
        )?;
        if exists.as_bool() != Some(true) {
            return Ok(None);
        }
        let file = self.rpc(
            ProtocolRpcMethod::Filesystem,
            json!({ "op": "readFile", "root": root, "path": path }),
        )?;
        if file.get("binary").and_then(Value::as_bool) == Some(true)
            || file.get("truncated").and_then(Value::as_bool) == Some(true)
        {
            return Err(GatewayError::InvalidPayload(format!(
                "{path} must be a small UTF-8 text file"
            )));
        }
        Ok(file
            .get("text")
            .and_then(Value::as_str)
            .map(ToString::to_string))
    }

    /// Spawns a session and returns its event stream.
    ///
    /// The shell is left to the server to resolve: the phone has no shell
    /// picker, so a session it opens follows the project's configured default.
    pub fn spawn_stream(
        &self,
        session_id: String,
        worktree_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> GatewayResult<LocalStream> {
        self.ensure_protocol()?;
        self.client
            .spawn_stream(session_id, worktree_id, cwd, cols, rows, None)
            .map_err(GatewayError::from)
    }

    /// Attaches to a session event stream. A `Some` size resizes the PTY to
    /// the attacher's viewport; `None` observes without resizing.
    pub fn attach_stream(
        &self,
        session_id: String,
        size: Option<(u16, u16)>,
    ) -> GatewayResult<LocalStream> {
        self.ensure_protocol()?;
        self.client
            .attach_stream(session_id, size, None)
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

    /// Reports one rich agent message.
    pub fn report_agent_message(&self, message: &AgentMessage) -> GatewayResult<()> {
        self.ensure_protocol()?;
        self.client
            .report_agent_message(message)
            .map_err(GatewayError::from)
    }

    /// Publishes a command-approval verdict.
    pub fn report_agent_decision(&self, decision: &AgentDecision) -> GatewayResult<()> {
        self.ensure_protocol()?;
        self.client
            .report_agent_decision(decision)
            .map_err(GatewayError::from)
    }

    /// Publishes a reply to a question request.
    pub fn report_agent_answer(&self, answer: &AgentAnswer) -> GatewayResult<()> {
        self.ensure_protocol()?;
        self.client
            .report_agent_answer(answer)
            .map_err(GatewayError::from)
    }

    /// Publishes a free-form interjection for a running agent.
    pub fn report_agent_input(&self, input: &AgentInput) -> GatewayResult<()> {
        self.ensure_protocol()?;
        self.client
            .report_agent_input(input)
            .map_err(GatewayError::from)
    }

    /// Publishes a transient interrupt for a running agent.
    pub fn report_agent_interrupt(&self, interrupt: &AgentInterrupt) -> GatewayResult<()> {
        self.ensure_protocol()?;
        self.client
            .report_agent_interrupt(interrupt)
            .map_err(GatewayError::from)
    }

    /// Opens the agent event stream.
    pub fn subscribe_agents_stream(&self) -> GatewayResult<LocalStream> {
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
    ) -> GatewayResult<LocalStream> {
        self.ensure_protocol()?;
        self.client
            .subscribe_stream(event, worktree_id, cwd)
            .map_err(GatewayError::from)
    }
}
