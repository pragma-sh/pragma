use std::io::{Read, Write};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use pragma_constants::{AgentAttentionKind, AgentReportPayload, AgentStatus};

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
/// Upper bound on a single frame's body. Guards against malformed lengths.
const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;

/// A decoded wire frame. Control traffic stays JSON; PTY output is binary.
pub enum Frame {
    /// JSON body — deserialize with [`Frame::decode`] into the expected type.
    Json(Vec<u8>),
    /// Raw terminal output for `session_id`. Body layout after the tag is
    /// `[2-byte BE session-id length][session id UTF-8][raw output bytes]`.
    Output { session_id: String, data: Vec<u8> },
}

impl Frame {
    /// Deserializes a JSON frame into `T`, erroring if the frame was binary.
    pub fn decode<T: for<'de> Deserialize<'de>>(self) -> Result<T, ProtocolError> {
        match self {
            Self::Json(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Self::Output { .. } => Err(ProtocolError::UnexpectedBinaryFrame),
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
    /// Subscribes to daemon-wide agent status events.
    SubscribeAgents,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseFrame {
    pub request_id: String,
    pub ok: bool,
    pub error: Option<String>,
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
        status: AgentStatus,
        #[serde(rename = "attentionKind")]
        attention_kind: Option<AgentAttentionKind>,
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
    Event(EventFrame),
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
            if body.len() < 3 {
                return Err(ProtocolError::Malformed);
            }
            let sid_len = u16::from_be_bytes([body[1], body[2]]) as usize;
            let sid_end = 3 + sid_len;
            if body.len() < sid_end {
                return Err(ProtocolError::Malformed);
            }
            let session_id = String::from_utf8(body[3..sid_end].to_vec())
                .map_err(|_| ProtocolError::Malformed)?;
            let data = body[sid_end..].to_vec();
            Ok(Frame::Output { session_id, data })
        }
        _ => Err(ProtocolError::Malformed),
    }
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
    let sid = session_id.as_bytes();
    let sid_len = u16::try_from(sid.len()).map_err(|_| ProtocolError::FrameTooLarge)?;
    let body_len = 1 + 2 + sid.len() + data.len();
    let len = u32::try_from(body_len).map_err(|_| ProtocolError::FrameTooLarge)?;
    if body_len > MAX_FRAME_LEN {
        return Err(ProtocolError::FrameTooLarge);
    }
    let mut header = Vec::with_capacity(4 + 1 + 2 + sid.len());
    header.extend_from_slice(&len.to_be_bytes());
    header.push(FRAME_TAG_OUTPUT);
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
        read_frame, read_json_frame, write_json_frame, write_output_frame, EventFrame, Frame,
        HelloFrame, ProtocolError, RequestFrame, RequestKind, ServerFrame,
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
        };
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &frame).expect("write frame");
        let decoded: RequestFrame = read_json_frame(&mut bytes.as_slice()).expect("read frame");
        assert_eq!(decoded.request_id, "1");
        assert!(matches!(decoded.kind, RequestKind::Resize));
        assert_eq!(decoded.cols, Some(80));
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
            Frame::Json(_) => panic!("expected output frame"),
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
            ServerFrame::Response(_) | ServerFrame::Event(_) => panic!("expected hello"),
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
            | ServerFrame::Event(
                EventFrame::Output { .. } | EventFrame::Exit { .. } | EventFrame::Agent { .. },
            ) => {
                panic!("expected title")
            }
        }
    }
}
