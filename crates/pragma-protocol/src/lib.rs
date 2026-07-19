use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use pragma_constants::{
    AgentAnswer, AgentAttentionKind, AgentDecision, AgentInput, AgentInterrupt, AgentMessage,
    AgentReportPayload, AgentSessionLaunchPayload, AgentStatus, ControlMethod, NewWorktreeSpec,
    ProtocolErrorCode, ProtocolEventKind, ProtocolRpcMethod, QuestionOption, WorkspaceSnapshot,
};

/// Channel name shared by every production build. It is stable so an installed
/// app always resolves the same daemon socket and the same database, and so the
/// production data dir is never relocated out from under an existing install.
pub const PROD_CHANNEL: &str = "pragma";

/// Derives the per-worktree development channel (`pragma-dev-<hash>`) from the
/// absolute workspace root the binary was compiled in.
///
/// Two worktree checkouts live at different paths, so they hash to different
/// channels and never share a daemon, socket, lock, log, or database — and a dev
/// build never collides with production (`pragma`). The same worktree hashes
/// identically across rebuilds, so its daemon and data dir persist. The app and
/// the daemon compute this the same way (same `std` hasher over the same path),
/// so a hand-run `cargo run -p pragma-server` in a worktree resolves the same
/// channel as that worktree's app even without the `PRAGMA_DAEMON_CHANNEL` env.
#[must_use]
pub fn dev_channel(workspace_root: &Path) -> String {
    // `DefaultHasher::new` uses fixed keys, so this is deterministic across
    // processes and rebuilds — unlike `RandomState`.
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    workspace_root.hash(&mut hasher);
    format!("pragma-dev-{:016x}", hasher.finish())
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("frame is too large")]
    FrameTooLarge,
    #[error("malformed frame")]
    Malformed,
    #[error("expected a JSON frame but received a binary one")]
    UnexpectedBinaryFrame,
}

/// Tag for a JSON-bodied frame (control frames: hello, requests, responses,
/// title/exit events).
const FRAME_TAG_JSON: u8 = 0;
/// Tag for a binary output frame. Terminal output is shipped raw — no JSON
/// escaping and no UTF-8 decode/encode.
const FRAME_TAG_OUTPUT: u8 = 1;
/// Tag for a binary input frame. Terminal input is fire-and-forget on the hot
/// path: no JSON request, UUID, or response frame per keystroke.
const FRAME_TAG_INPUT: u8 = 2;
/// Upper bound on a single frame's body. Guards against malformed lengths.
const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;

/// A decoded wire frame. Control traffic stays JSON; PTY input/output is binary.
pub enum Frame {
    /// JSON body — deserialize with [`Frame::decode`] into the expected type.
    Json(Vec<u8>),
    /// Raw terminal output for `session_id`. Body layout after the tag is
    /// `[2-byte BE session-id length][session id UTF-8][raw output bytes]`.
    Output { session_id: String, data: Vec<u8> },
    /// Raw terminal input for `session_id`. Body layout after the tag matches
    /// [`Self::Output`].
    Input { session_id: String, data: Vec<u8> },
}

impl Frame {
    /// Deserializes a JSON frame into `T`, erroring if the frame was binary.
    pub fn decode<T: for<'de> Deserialize<'de>>(self) -> Result<T, ProtocolError> {
        match self {
            Self::Json(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Self::Output { .. } | Self::Input { .. } => Err(ProtocolError::UnexpectedBinaryFrame),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestFrame {
    pub request_id: String,
    pub kind: RequestKind,
    pub session_id: Option<String>,
    pub worktree_id: Option<String>,
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rpc: Option<RpcRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription: Option<SubscriptionRequest>,
    /// Carries a brokered control request (CLI → server → controller app).
    /// Present only for [`RequestKind::Control`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control: Option<ControlRequest>,
    /// Carries the controller app's reply to a forwarded control request
    /// (app → server). Present only for [`RequestKind::ControlResult`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_result: Option<ControlResult>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RequestKind {
    Spawn,
    Attach,
    Write,
    Resize,
    Kill,
    /// Terminates every session whose initial cwd matches `data` (a path).
    KillForCwd,
    /// Reports agent status. `data` carries a JSON [`AgentReportPayload`].
    AgentReport,
    /// Reports one rich agent message. `data` carries a JSON [`AgentMessage`].
    AgentMessage,
    /// Publishes an approve/deny verdict for a command-approval request. `data`
    /// carries a JSON [`AgentDecision`]. The server fans it out to agent
    /// subscribers so the waiting reporter (hook or watcher) can act on it.
    AgentDecision,
    /// Publishes a reply to a `question` attention request. `data` carries a
    /// JSON [`AgentAnswer`]. The server fans it out to agent subscribers so the
    /// waiting reporter (hook or watcher) can act on it.
    AgentAnswer,
    /// Publishes free-form input (an interjection) for a running agent. `data`
    /// carries a JSON [`AgentInput`]. The server fans it out to agent
    /// subscribers so the waiting reporter (hook or watcher) delivers the text
    /// into the agent's turn.
    AgentInput,
    /// Publishes a transient interrupt for a running agent. `data` carries a
    /// JSON [`AgentInterrupt`]. The server fans it out to agent subscribers so a
    /// watcher can send an interrupt (ESC) into the agent's tab. No replay
    /// buffer: delivery is best-effort to live subscribers only.
    AgentInterrupt,
    /// Subscribes to daemon-wide agent status events.
    SubscribeAgents,
    /// Marks a tab's resolved (`done`) agent statuses as seen so the daemon
    /// stops replaying them on the next subscriber reconnect. `sessionId` is the
    /// tab id; `running`/`attention` statuses are left untouched.
    MarkAgentsSeen,
    /// Request/response business-logic RPC. `rpc` carries the method and payload.
    Rpc,
    /// Snapshot-then-delta event subscription. `subscription` carries the event kind.
    Subscribe,
    /// The GUI app registers itself as the single controller so the server can
    /// forward brokered [`Control`](Self::Control) requests to it. Sent once by
    /// the app's control bridge right after the `Hello` frame. The server stores
    /// the connection's writer in `Registry.controller`.
    RegisterController,
    /// A brokered control request from the CLI. `control` carries the
    /// [`ControlMethod`] + JSON payload; `request_id` correlates the reply.
    /// The server forwards it to the controller app and waits for the matching
    /// [`ControlResult`](Self::ControlResult).
    Control,
    /// The controller app's reply to a forwarded `Control` request. `control_result`
    /// carries the payload or error; `request_id` matches the forwarded request.
    ControlResult,
    /// Publishes a full `WorkspaceSnapshot` (projects/worktrees/tabs) the desktop
    /// app mirrors from its `SQLite` state. The server caches it and broadcasts a
    /// `Delta` carrying the replacement snapshot to `workspace` subscribers, so a
    /// remote client (e.g. a paired phone) can render the session launcher without
    /// registering as the controller. Fire-and-forget: the publishing app never
    /// blocks on it. `data` carries a JSON [`WorkspaceSnapshot`].
    PublishWorkspace,
}

/// Request payload for generalized server-owned business-logic RPC.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequest {
    pub method: ProtocolRpcMethod,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// Request payload for snapshot-then-delta subscriptions.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionRequest {
    pub event: ProtocolEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// A brokered control request: the operation to run in the controller app plus a
/// JSON payload of arguments. Carried in [`RequestFrame::control`] for
/// [`RequestKind::Control`], and forwarded to the controller app inside a
/// [`ControlEnvelope`] (which adds the `request_id`).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub method: ControlMethod,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// The forwarded control request the server writes to the controller app. Adds
/// the `request_id` so the app can tag its [`ControlResult`] reply.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlEnvelope {
    pub request_id: String,
    pub method: ControlMethod,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// The controller app's reply to a `Control` request. Carried in
/// [`RequestFrame::control_result`] (app → server) and in
/// [`ServerFrame::ControlResult`] (server → CLI). `request_id` is taken from the
/// frame that carries it, so it is omitted here.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseFrame {
    pub request_id: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Response frame for generalized RPC requests.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcResponseFrame {
    pub request_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

/// Protocol-level RPC error.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: ProtocolErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum EventFrame {
    /// Raw terminal output. Unlike the other variants this never crosses the
    /// wire as JSON — it is written with [`write_output_frame`].
    Output {
        #[serde(rename = "sessionId")]
        session_id: String,
        data: Vec<u8>,
    },
    /// Shell-emitted window title (OSC 0 / OSC 2).
    Title {
        #[serde(rename = "sessionId")]
        session_id: String,
        title: String,
    },
    Exit {
        #[serde(rename = "sessionId")]
        session_id: String,
        code: Option<i32>,
    },
    Agent {
        #[serde(rename = "worktreeId")]
        worktree_id: String,
        #[serde(rename = "tabId")]
        tab_id: String,
        agent: String,
        /// Effective agent status; `None` only for a status-less report (a
        /// `session-name` rename before any status was ever reported).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<AgentStatus>,
        /// Human-readable session name, when the agent has reported one.
        #[serde(
            rename = "sessionName",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        session_name: Option<String>,
        #[serde(rename = "attentionKind")]
        attention_kind: Option<AgentAttentionKind>,
        /// The command awaiting approval, when `status` is a `command` attention.
        #[serde(rename = "command", default, skip_serializing_if = "Option::is_none")]
        command: Option<String>,
        /// The question awaiting an answer, when `status` is a `question` attention.
        #[serde(rename = "question", default, skip_serializing_if = "Option::is_none")]
        question: Option<String>,
        /// Answer choices for a `question` attention, when present.
        #[serde(rename = "options", default, skip_serializing_if = "Option::is_none")]
        options: Option<Vec<QuestionOption>>,
        /// Correlation id for a command-approval or question round-trip, when present.
        #[serde(rename = "requestId", default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    AgentMessage {
        message: AgentMessage,
    },
    /// An approve/deny verdict fanned out to agent subscribers.
    AgentDecision {
        decision: AgentDecision,
    },
    /// A reply to a `question` attention request, fanned out to agent subscribers.
    AgentAnswer {
        answer: AgentAnswer,
    },
    /// Free-form input (an interjection) for a running agent, fanned out to
    /// agent subscribers so a hook or watcher can deliver it into the turn.
    AgentInput {
        input: AgentInput,
    },
    /// A transient interrupt for a running agent, fanned out to agent
    /// subscribers so a watcher can send an interrupt (ESC) into the tab.
    AgentInterrupt {
        interrupt: AgentInterrupt,
    },
    /// First message for a subscription, carrying the complete current state.
    Snapshot {
        subscription: ProtocolEventKind,
        #[serde(default)]
        payload: serde_json::Value,
    },
    /// Incremental event after a subscription snapshot.
    Delta {
        subscription: ProtocolEventKind,
        #[serde(default)]
        payload: serde_json::Value,
    },
    /// Terminal echo-mode update used by client-local predictive echo.
    EchoMode {
        #[serde(rename = "sessionId")]
        session_id: String,
        echo: bool,
    },
}

/// Sent by the daemon as the first frame on every accepted connection.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloFrame {
    pub protocol_version: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "frame", rename_all = "camelCase")]
pub enum ServerFrame {
    Hello(HelloFrame),
    Response(ResponseFrame),
    Rpc(RpcResponseFrame),
    Event(EventFrame),
    /// A brokered control request forwarded from a CLI connection to the
    /// controller app. The app dispatches `method`, runs the matching Tauri
    /// command, and writes back a [`RequestFrame`] with
    /// [`RequestKind::ControlResult`].
    Control(ControlEnvelope),
    /// The result of a brokered control request, returned to the CLI. Carries
    /// the JSON payload of the executed Tauri command, or an error.
    ControlResult(ControlResult),
}

/// Reads one length-prefixed frame and splits it by tag.
pub fn read_frame(reader: &mut impl Read) -> Result<Frame, ProtocolError> {
    let mut len_bytes = [0_u8; 4];
    reader.read_exact(&mut len_bytes)?;
    let len = u32::from_be_bytes(len_bytes) as usize;
    if len == 0 {
        return Err(ProtocolError::Malformed);
    }
    if len > MAX_FRAME_LEN {
        return Err(ProtocolError::FrameTooLarge);
    }
    let mut body = vec![0_u8; len];
    reader.read_exact(&mut body)?;
    match body[0] {
        FRAME_TAG_JSON => Ok(Frame::Json(body.split_off(1))),
        FRAME_TAG_OUTPUT => {
            let (session_id, data) = decode_session_data(&body)?;
            Ok(Frame::Output { session_id, data })
        }
        FRAME_TAG_INPUT => {
            let (session_id, data) = decode_session_data(&body)?;
            Ok(Frame::Input { session_id, data })
        }
        _ => Err(ProtocolError::Malformed),
    }
}

fn decode_session_data(body: &[u8]) -> Result<(String, Vec<u8>), ProtocolError> {
    if body.len() < 3 {
        return Err(ProtocolError::Malformed);
    }
    let sid_len = u16::from_be_bytes([body[1], body[2]]) as usize;
    let sid_end = 3 + sid_len;
    if body.len() < sid_end {
        return Err(ProtocolError::Malformed);
    }
    let session_id =
        String::from_utf8(body[3..sid_end].to_vec()).map_err(|_| ProtocolError::Malformed)?;
    let data = body[sid_end..].to_vec();
    Ok((session_id, data))
}

/// Reads one frame and decodes it as JSON `T`, erroring on a binary frame.
pub fn read_json_frame<T: for<'de> Deserialize<'de>>(
    reader: &mut impl Read,
) -> Result<T, ProtocolError> {
    read_frame(reader)?.decode()
}

/// Writes a JSON control frame (hello, request, response, title/exit event).
pub fn write_json_frame<T: Serialize>(
    writer: &mut impl Write,
    frame: &T,
) -> Result<(), ProtocolError> {
    let json = serde_json::to_vec(frame)?;
    let body_len = 1 + json.len();
    let len = u32::try_from(body_len).map_err(|_| ProtocolError::FrameTooLarge)?;
    if body_len > MAX_FRAME_LEN {
        return Err(ProtocolError::FrameTooLarge);
    }
    let mut buf = Vec::with_capacity(4 + body_len);
    buf.extend_from_slice(&len.to_be_bytes());
    buf.push(FRAME_TAG_JSON);
    buf.extend_from_slice(&json);
    writer.write_all(&buf)?;
    writer.flush()?;
    Ok(())
}

/// Writes a binary output frame carrying raw terminal bytes for `session_id`.
pub fn write_output_frame(
    writer: &mut impl Write,
    session_id: &str,
    data: &[u8],
) -> Result<(), ProtocolError> {
    write_session_data_frame(writer, FRAME_TAG_OUTPUT, session_id, data)
}

/// Writes a binary input frame carrying raw terminal input bytes for `session_id`.
pub fn write_input_frame(
    writer: &mut impl Write,
    session_id: &str,
    data: &[u8],
) -> Result<(), ProtocolError> {
    write_session_data_frame(writer, FRAME_TAG_INPUT, session_id, data)
}

fn write_session_data_frame(
    writer: &mut impl Write,
    tag: u8,
    session_id: &str,
    data: &[u8],
) -> Result<(), ProtocolError> {
    let sid = session_id.as_bytes();
    let sid_len = u16::try_from(sid.len()).map_err(|_| ProtocolError::FrameTooLarge)?;
    let body_len = 1 + 2 + sid.len() + data.len();
    let len = u32::try_from(body_len).map_err(|_| ProtocolError::FrameTooLarge)?;
    if body_len > MAX_FRAME_LEN {
        return Err(ProtocolError::FrameTooLarge);
    }
    let mut header = Vec::with_capacity(4 + 1 + 2 + sid.len());
    header.extend_from_slice(&len.to_be_bytes());
    header.push(tag);
    header.extend_from_slice(&sid_len.to_be_bytes());
    header.extend_from_slice(sid);
    writer.write_all(&header)?;
    writer.write_all(data)?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        read_frame, read_json_frame, write_input_frame, write_json_frame, write_output_frame,
        AgentAnswer, AgentDecision, AgentStatus, ControlEnvelope, ControlMethod, ControlRequest,
        ControlResult, EventFrame, Frame, HelloFrame, ProtocolError, RequestFrame, RequestKind,
        ServerFrame,
    };

    #[test]
    fn round_trips_length_prefixed_json() {
        let frame = RequestFrame {
            request_id: "1".to_string(),
            kind: RequestKind::Resize,
            session_id: Some("session".to_string()),
            worktree_id: None,
            cwd: None,
            cols: Some(80),
            rows: Some(24),
            data: None,
            rpc: None,
            subscription: None,
            control: None,
            control_result: None,
        };
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &frame).expect("write frame");
        let decoded: RequestFrame = read_json_frame(&mut bytes.as_slice()).expect("read frame");
        assert_eq!(decoded.request_id, "1");
        assert!(matches!(decoded.kind, RequestKind::Resize));
        assert_eq!(decoded.cols, Some(80));
    }

    #[test]
    fn round_trips_agent_command_and_decision_events() {
        let agent = ServerFrame::Event(EventFrame::Agent {
            worktree_id: "w".to_string(),
            tab_id: "t".to_string(),
            agent: "claude-code".to_string(),
            status: Some(AgentStatus::Attention),
            session_name: Some("Fix flaky tests".to_string()),
            attention_kind: Some(pragma_constants::AgentAttentionKind::Command),
            command: Some("npm test".to_string()),
            question: None,
            options: None,
            request_id: Some("req-1".to_string()),
        });
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &agent).expect("write agent event");
        let decoded: ServerFrame = read_json_frame(&mut bytes.as_slice()).expect("read agent");
        match decoded {
            ServerFrame::Event(EventFrame::Agent {
                command,
                request_id,
                ..
            }) => {
                assert_eq!(command.as_deref(), Some("npm test"));
                assert_eq!(request_id.as_deref(), Some("req-1"));
            }
            _ => panic!("expected agent event"),
        }

        let decision = ServerFrame::Event(EventFrame::AgentDecision {
            decision: AgentDecision {
                agent: "claude-code".to_string(),
                worktree_id: "w".to_string(),
                tab_id: "t".to_string(),
                request_id: "req-1".to_string(),
                approved: true,
            },
        });
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &decision).expect("write decision");
        let decoded: ServerFrame = read_json_frame(&mut bytes.as_slice()).expect("read decision");
        match decoded {
            ServerFrame::Event(EventFrame::AgentDecision { decision }) => {
                assert_eq!(decision.request_id, "req-1");
                assert!(decision.approved);
            }
            _ => panic!("expected decision event"),
        }

        let answer = ServerFrame::Event(EventFrame::AgentAnswer {
            answer: AgentAnswer {
                agent: "claude-code".to_string(),
                worktree_id: "w".to_string(),
                tab_id: "t".to_string(),
                request_id: "req-2".to_string(),
                answer: Some("use option B".to_string()),
                dismissed: false,
            },
        });
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &answer).expect("write answer");
        let decoded: ServerFrame = read_json_frame(&mut bytes.as_slice()).expect("read answer");
        match decoded {
            ServerFrame::Event(EventFrame::AgentAnswer { answer }) => {
                assert_eq!(answer.request_id, "req-2");
                assert_eq!(answer.answer.as_deref(), Some("use option B"));
                assert!(!answer.dismissed);
            }
            _ => panic!("expected answer event"),
        }
    }

    #[test]
    fn round_trips_binary_output() {
        let mut bytes = Vec::new();
        write_output_frame(&mut bytes, "tab-1", b"\x1b[31mred").expect("write output");
        match read_frame(&mut bytes.as_slice()).expect("read output") {
            Frame::Output { session_id, data } => {
                assert_eq!(session_id, "tab-1");
                assert_eq!(data, b"\x1b[31mred");
            }
            Frame::Json(_) | Frame::Input { .. } => panic!("expected output frame"),
        }
    }

    #[test]
    fn round_trips_binary_input() {
        let mut bytes = Vec::new();
        write_input_frame(&mut bytes, "tab-1", b"hello\r").expect("write input");
        match read_frame(&mut bytes.as_slice()).expect("read input") {
            Frame::Input { session_id, data } => {
                assert_eq!(session_id, "tab-1");
                assert_eq!(data, b"hello\r");
            }
            Frame::Json(_) | Frame::Output { .. } => panic!("expected input frame"),
        }
    }

    #[test]
    fn rejects_binary_when_json_expected() {
        let mut bytes = Vec::new();
        write_output_frame(&mut bytes, "tab-1", b"data").expect("write output");
        let err = read_json_frame::<ServerFrame>(&mut bytes.as_slice()).expect_err("json err");
        assert!(matches!(err, ProtocolError::UnexpectedBinaryFrame));
    }

    #[test]
    fn server_frame_is_tagged() {
        let frame = ServerFrame::Hello(HelloFrame {
            protocol_version: 3,
        });
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &frame).expect("write hello");
        let decoded: ServerFrame = read_json_frame(&mut bytes.as_slice()).expect("read hello");
        match decoded {
            ServerFrame::Hello(hello) => assert_eq!(hello.protocol_version, 3),
            ServerFrame::Response(_)
            | ServerFrame::Rpc(_)
            | ServerFrame::Event(_)
            | ServerFrame::Control(_)
            | ServerFrame::ControlResult(_) => {
                panic!("expected hello")
            }
        }
    }

    #[test]
    fn rpc_frame_round_trips() {
        let frame = ServerFrame::Rpc(super::RpcResponseFrame {
            request_id: "rpc-1".to_string(),
            ok: true,
            payload: Some(serde_json::json!({ "pong": true })),
            error: None,
        });
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &frame).expect("write rpc");
        let decoded: ServerFrame = read_json_frame(&mut bytes.as_slice()).expect("read rpc");
        match decoded {
            ServerFrame::Rpc(response) => assert_eq!(response.request_id, "rpc-1"),
            ServerFrame::Hello(_)
            | ServerFrame::Response(_)
            | ServerFrame::Event(_)
            | ServerFrame::Control(_)
            | ServerFrame::ControlResult(_) => {
                panic!("expected rpc")
            }
        }
    }

    #[test]
    fn control_request_round_trips() {
        let frame = RequestFrame {
            request_id: "ctrl-1".to_string(),
            kind: RequestKind::Control,
            session_id: None,
            worktree_id: None,
            cwd: None,
            cols: None,
            rows: None,
            data: None,
            rpc: None,
            subscription: None,
            control: Some(ControlRequest {
                method: ControlMethod::TabsList,
                payload: serde_json::json!({ "projectId": "p1" }),
            }),
            control_result: None,
        };
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &frame).expect("write control");
        let decoded: RequestFrame = read_json_frame(&mut bytes.as_slice()).expect("read control");
        assert_eq!(decoded.request_id, "ctrl-1");
        assert!(matches!(decoded.kind, RequestKind::Control));
        let control = decoded.control.expect("control payload");
        assert!(matches!(control.method, ControlMethod::TabsList));
        assert_eq!(control.payload, serde_json::json!({ "projectId": "p1" }));
    }

    #[test]
    fn server_control_envelope_round_trips() {
        let frame = ServerFrame::Control(ControlEnvelope {
            request_id: "ctrl-2".to_string(),
            method: ControlMethod::BrowserNavigate,
            payload: serde_json::json!({ "tabId": "t1", "url": "https://example.com" }),
        });
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &frame).expect("write envelope");
        let decoded: ServerFrame = read_json_frame(&mut bytes.as_slice()).expect("read envelope");
        match decoded {
            ServerFrame::Control(envelope) => {
                assert_eq!(envelope.request_id, "ctrl-2");
                assert!(matches!(envelope.method, ControlMethod::BrowserNavigate));
            }
            ServerFrame::Hello(_)
            | ServerFrame::Response(_)
            | ServerFrame::Rpc(_)
            | ServerFrame::Event(_)
            | ServerFrame::ControlResult(_) => panic!("expected control envelope"),
        }
    }

    #[test]
    fn control_result_round_trips() {
        let frame = ServerFrame::ControlResult(ControlResult {
            ok: true,
            payload: Some(serde_json::json!({ "tabId": "t9" })),
            error: None,
        });
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &frame).expect("write result");
        let decoded: ServerFrame = read_json_frame(&mut bytes.as_slice()).expect("read result");
        match decoded {
            ServerFrame::ControlResult(result) => {
                assert!(result.ok);
                assert_eq!(result.payload, Some(serde_json::json!({ "tabId": "t9" })));
                assert!(result.error.is_none());
            }
            ServerFrame::Hello(_)
            | ServerFrame::Response(_)
            | ServerFrame::Rpc(_)
            | ServerFrame::Event(_)
            | ServerFrame::Control(_) => panic!("expected control result"),
        }
    }

    #[test]
    fn event_frame_round_trips_title() {
        let frame = ServerFrame::Event(EventFrame::Title {
            session_id: "tab".to_string(),
            title: "repo".to_string(),
        });
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &frame).expect("write event");
        let decoded: ServerFrame = read_json_frame(&mut bytes.as_slice()).expect("read event");
        match decoded {
            ServerFrame::Event(EventFrame::Title { session_id, title }) => {
                assert_eq!(session_id, "tab");
                assert_eq!(title, "repo");
            }
            ServerFrame::Hello(_)
            | ServerFrame::Response(_)
            | ServerFrame::Rpc(_)
            | ServerFrame::Control(_)
            | ServerFrame::ControlResult(_)
            | ServerFrame::Event(
                EventFrame::Output { .. }
                | EventFrame::Exit { .. }
                | EventFrame::Agent { .. }
                | EventFrame::AgentMessage { .. }
                | EventFrame::AgentDecision { .. }
                | EventFrame::AgentAnswer { .. }
                | EventFrame::AgentInput { .. }
                | EventFrame::AgentInterrupt { .. }
                | EventFrame::Snapshot { .. }
                | EventFrame::Delta { .. }
                | EventFrame::EchoMode { .. },
            ) => {
                panic!("expected title")
            }
        }
    }
}
