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
    Output {
        #[serde(rename = "sessionId")]
        session_id: String,
        data: String,
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

pub fn read_frame<T: for<'de> Deserialize<'de>>(
    reader: &mut impl Read,
) -> Result<T, ProtocolError> {
    let mut len_bytes = [0_u8; 4];
    reader.read_exact(&mut len_bytes)?;
    let len = u32::from_be_bytes(len_bytes);
    if len > 16 * 1024 * 1024 {
        return Err(ProtocolError::FrameTooLarge);
    }
    let mut bytes = vec![0_u8; len as usize];
    reader.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn write_frame<T: Serialize>(writer: &mut impl Write, frame: &T) -> Result<(), ProtocolError> {
    let bytes = serde_json::to_vec(frame)?;
    let len = u32::try_from(bytes.len()).map_err(|_| ProtocolError::FrameTooLarge)?;
    writer.write_all(&len.to_be_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        read_frame, write_frame, EventFrame, HelloFrame, RequestFrame, RequestKind, ServerFrame,
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
        write_frame(&mut bytes, &frame).expect("frame should encode");
        let decoded: RequestFrame = read_frame(&mut bytes.as_slice()).expect("frame should decode");
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

        let decoded: ServerFrame = read_frame(
            &mut {
                let mut bytes = Vec::new();
                write_frame(
                    &mut bytes,
                    &ServerFrame::Hello(HelloFrame {
                        protocol_version: 7,
                    }),
                )
                .expect("hello should encode");
                bytes
            }
            .as_slice(),
        )
        .expect("hello should decode");
        match decoded {
            ServerFrame::Hello(hello) => assert_eq!(hello.protocol_version, 7),
            _ => panic!("expected a hello frame"),
        }
    }

    #[test]
    fn event_frames_use_camel_case_session_id() {
        let frame = ServerFrame::Event(EventFrame::Output {
            session_id: "session".to_string(),
            data: "hi".to_string(),
        });
        let json = serde_json::to_string(&frame).expect("event should encode");
        assert!(json.contains("sessionId"));
        assert!(!json.contains("session_id"));
    }
}
