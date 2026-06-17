use std::io::{Read, Write};

use serde::{Deserialize, Serialize};
use thiserror::Error;

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
/// escaping (which expands each 0x1B escape byte ~6x) and no UTF-8
/// decode/encode — so a full-grid redraw crosses the wire as bytes and reaches
/// xterm's parser directly. See [`Frame::Output`] for the body layout.
const FRAME_TAG_OUTPUT: u8 = 1;
/// Upper bound on a single frame's body, mirrored on the app side. Guards
/// against a malformed/oversized length OOM-ing either process.
const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;

/// A decoded wire frame. Control traffic stays JSON; PTY output is binary.
pub enum Frame {
    /// JSON body — deserialize with [`Frame::decode`] into the expected type.
    Json(Vec<u8>),
    /// Raw terminal output for `session_id`. Body layout after the tag is
    /// `[2-byte BE session-id length][session id UTF-8][raw output bytes]`.
    ///
    /// The daemon only ever *writes* output frames (it reads requests, which are
    /// always JSON), so these fields are read only by tests and by the app's
    /// mirror of this protocol — hence `allow(dead_code)` for the daemon binary.
    #[allow(dead_code)]
    Output { session_id: String, data: Vec<u8> },
}

impl Frame {
    /// Deserializes a JSON frame into `T`, erroring if the frame was binary.
    pub fn decode<T: for<'de> Deserialize<'de>>(self) -> Result<T, ProtocolError> {
        match self {
            Frame::Json(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Frame::Output { .. } => Err(ProtocolError::UnexpectedBinaryFrame),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestFrame {
    pub request_id: String,
    pub kind: RequestKind,
    pub session_id: Option<String>,
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
    /// wire as JSON — it is written with [`write_output_frame`] as a binary
    /// frame — so `data` is bytes, not a string.
    Output {
        #[serde(rename = "sessionId")]
        session_id: String,
        data: Vec<u8>,
    },
    /// Shell-emitted window title (OSC 0 / OSC 2). The frontend decides whether
    /// to apply it to the tab strip based on whether the user has manually
    /// renamed that terminal tab.
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
}

/// Sent by the daemon as the very first frame on every accepted connection so
/// the app can detect — and replace — a stale long-lived daemon whose protocol
/// no longer matches the app build.
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

/// Reads one length-prefixed frame and splits it by tag: control frames come
/// back as [`Frame::Json`] (decode with [`Frame::decode`]), output frames as
/// [`Frame::Output`].
pub fn read_frame(reader: &mut impl Read) -> Result<Frame, ProtocolError> {
    let mut len_bytes = [0_u8; 4];
    reader.read_exact(&mut len_bytes)?;
    let len = u32::from_be_bytes(len_bytes) as usize;
    // The body always carries at least the 1-byte tag.
    if len == 0 || len > MAX_FRAME_LEN {
        return Err(ProtocolError::FrameTooLarge);
    }
    let mut body = vec![0_u8; len];
    reader.read_exact(&mut body)?;
    match body[0] {
        FRAME_TAG_JSON => Ok(Frame::Json(body.split_off(1))),
        FRAME_TAG_OUTPUT => {
            // [tag][2-byte BE session-id length][session id][raw output bytes]
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
/// The header (length + tag + session id) is sent in one write and the payload
/// in a second, so a large redraw is at most two syscalls and never copied.
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
        HelloFrame, RequestFrame, RequestKind, ServerFrame,
    };

    #[test]
    fn round_trips_length_prefixed_json() {
        let frame = RequestFrame {
            request_id: "1".to_string(),
            kind: RequestKind::Resize,
            session_id: Some("session".to_string()),
            cwd: None,
            cols: Some(80),
            rows: Some(24),
            data: None,
        };
        let mut bytes = Vec::new();
        write_json_frame(&mut bytes, &frame).expect("frame should encode");
        let decoded: RequestFrame =
            read_json_frame(&mut bytes.as_slice()).expect("frame should decode");
        assert_eq!(decoded.request_id, "1");
        assert!(matches!(decoded.kind, RequestKind::Resize));
    }

    #[test]
    fn hello_frame_uses_camel_case_and_round_trips() {
        let json = serde_json::to_string(&ServerFrame::Hello(HelloFrame {
            protocol_version: 7,
        }))
        .expect("hello should encode");
        assert!(json.contains("\"frame\":\"hello\""));
        assert!(json.contains("\"protocolVersion\":7"));
        assert!(!json.contains("protocol_version"));

        let mut bytes = Vec::new();
        write_json_frame(
            &mut bytes,
            &ServerFrame::Hello(HelloFrame {
                protocol_version: 7,
            }),
        )
        .expect("hello should encode");
        let decoded: ServerFrame =
            read_json_frame(&mut bytes.as_slice()).expect("hello should decode");
        match decoded {
            ServerFrame::Hello(hello) => assert_eq!(hello.protocol_version, 7),
            _ => panic!("expected a hello frame"),
        }
    }

    #[test]
    fn title_event_uses_camel_case_session_id() {
        // Title/exit still travel as JSON; only output is binary.
        let frame = ServerFrame::Event(EventFrame::Title {
            session_id: "session".to_string(),
            title: "hi".to_string(),
        });
        let json = serde_json::to_string(&frame).expect("event should encode");
        assert!(json.contains("sessionId"));
        assert!(!json.contains("session_id"));
    }

    #[test]
    fn output_frame_round_trips_as_binary() {
        // Raw output — including ESC bytes and invalid UTF-8 — must survive the
        // wire untouched and arrive as a binary frame, not JSON.
        let payload = [0x1B, b'[', b'2', b'J', 0xFF, 0x00, b'x'];
        let mut bytes = Vec::new();
        write_output_frame(&mut bytes, "sess-1", &payload).expect("output should encode");
        // A binary frame is never valid JSON.
        assert!(read_json_frame::<ServerFrame>(&mut bytes.as_slice()).is_err());
        match read_frame(&mut bytes.as_slice()).expect("output should decode") {
            Frame::Output { session_id, data } => {
                assert_eq!(session_id, "sess-1");
                assert_eq!(data, payload);
            }
            Frame::Json(_) => panic!("expected a binary output frame"),
        }
    }
}
