use std::io::{self, Read};
use std::sync::mpsc::{self, Receiver};
use std::thread;

use pragma_protocol::{read_frame, EventFrame, Frame, ServerFrame};
use serde::Serialize;
use serde_json::{json, Value};
use tiny_http::{Header, Response, StatusCode};

use crate::error::{ErrorBody, GatewayError, GatewayResult};

/// Builds a JSON HTTP response.
pub fn json_response<T: Serialize>(
    status: u16,
    value: &T,
) -> GatewayResult<Response<std::io::Cursor<Vec<u8>>>> {
    let body = serde_json::to_vec(value)?;
    let mut response = Response::from_data(body).with_status_code(StatusCode(status));
    response.add_header(json_header());
    Ok(response)
}

/// Builds an empty HTTP response.
#[must_use]
pub fn empty_response(status: u16) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(Vec::new()).with_status_code(StatusCode(status))
}

/// Builds an error response.
pub fn error_response(error: &GatewayError) -> Response<std::io::Cursor<Vec<u8>>> {
    json_response(error.status(), &ErrorBody::from(error)).unwrap_or_else(|_| {
        Response::from_string("{\"code\":\"internal\",\"message\":\"failed to serialize error\"}")
            .with_status_code(StatusCode(500))
    })
}

/// Builds an NDJSON response from an existing server stream.
#[must_use]
pub fn ndjson_response(stream: std::os::unix::net::UnixStream) -> Response<NdjsonReader> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || forward_stream(stream, &tx));
    let mut response = Response::new(
        StatusCode(200),
        vec![ndjson_header()],
        NdjsonReader {
            rx,
            current: b"{\"type\":\"ready\"}\n".to_vec(),
        },
        None,
        None,
    )
    .with_chunked_threshold(0);
    response.add_header(no_cache_header());
    response
}

/// Serializes one event frame as gateway NDJSON.
pub fn event_json(event: EventFrame) -> Value {
    match event {
        EventFrame::Output { session_id, data } => json!({
            "type": "output",
            "sessionId": session_id,
            "dataBase64": base64_encode(&data),
        }),
        EventFrame::Title { session_id, title } => json!({
            "type": "title",
            "sessionId": session_id,
            "title": title,
        }),
        EventFrame::Exit { session_id, code } => json!({
            "type": "exit",
            "sessionId": session_id,
            "code": code,
        }),
        EventFrame::Agent {
            worktree_id,
            tab_id,
            agent,
            status,
            attention_kind,
            command,
            question,
            request_id,
        } => json!({
            "type": "agent",
            "worktreeId": worktree_id,
            "tabId": tab_id,
            "agent": agent,
            "status": status,
            "attentionKind": attention_kind,
            "command": command,
            "question": question,
            "requestId": request_id,
        }),
        EventFrame::AgentMessage { message } => json!({
            "type": "agentMessage",
            "message": message,
        }),
        EventFrame::AgentDecision { decision } => json!({
            "type": "agentDecision",
            "decision": decision,
        }),
        EventFrame::AgentAnswer { answer } => json!({
            "type": "agentAnswer",
            "answer": answer,
        }),
        EventFrame::AgentInput { input } => json!({
            "type": "agentInput",
            "input": input,
        }),
        EventFrame::Snapshot {
            subscription,
            payload,
        } => json!({
            "type": "snapshot",
            "subscription": subscription,
            "payload": payload,
        }),
        EventFrame::Delta {
            subscription,
            payload,
        } => json!({
            "type": "delta",
            "subscription": subscription,
            "payload": payload,
        }),
        EventFrame::EchoMode { session_id, echo } => json!({
            "type": "echoMode",
            "sessionId": session_id,
            "echo": echo,
        }),
    }
}

/// Reader backed by NDJSON lines received from a forwarding thread.
pub struct NdjsonReader {
    rx: Receiver<Vec<u8>>,
    current: Vec<u8>,
}

impl Read for NdjsonReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        while self.current.is_empty() {
            match self.rx.recv() {
                Ok(line) => self.current = line,
                Err(_) => return Ok(0),
            }
        }
        let len = buf.len().min(self.current.len());
        buf[..len].copy_from_slice(&self.current[..len]);
        self.current.drain(..len);
        Ok(len)
    }
}

fn forward_stream(mut stream: std::os::unix::net::UnixStream, tx: &mpsc::Sender<Vec<u8>>) {
    loop {
        let event = match read_frame(&mut stream) {
            Ok(Frame::Output { session_id, data }) => EventFrame::Output { session_id, data },
            Ok(Frame::Json(bytes)) => match serde_json::from_slice::<ServerFrame>(&bytes) {
                Ok(ServerFrame::Event(event)) => event,
                Ok(
                    ServerFrame::Hello(_)
                    | ServerFrame::Response(_)
                    | ServerFrame::Rpc(_)
                    | ServerFrame::Control(_)
                    | ServerFrame::ControlResult(_),
                ) => continue,
                Err(_) => break,
            },
            Ok(Frame::Input { .. }) => continue,
            Err(_) => break,
        };
        let is_exit = matches!(event, EventFrame::Exit { .. });
        let Ok(mut line) = serde_json::to_vec(&event_json(event)) else {
            break;
        };
        line.push(b'\n');
        if tx.send(line).is_err() || is_exit {
            break;
        }
    }
}

fn json_header() -> Header {
    Header::from_bytes(&b"content-type"[..], &b"application/json"[..]).expect("valid header")
}

fn ndjson_header() -> Header {
    Header::from_bytes(&b"content-type"[..], &b"application/x-ndjson"[..]).expect("valid header")
}

fn no_cache_header() -> Header {
    Header::from_bytes(&b"cache-control"[..], &b"no-cache"[..]).expect("valid header")
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        out.push(TABLE[(first >> 2) as usize] as char);
        out.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(third & 0b0011_1111) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use pragma_protocol::EventFrame;

    use super::event_json;

    #[test]
    fn serializes_output_as_base64_ndjson_payload() {
        let value = event_json(EventFrame::Output {
            session_id: "tab".to_string(),
            data: b"hi".to_vec(),
        });
        assert_eq!(value["type"], "output");
        assert_eq!(value["dataBase64"], "aGk=");
    }

    #[test]
    fn serializes_subscription_snapshot_with_type() {
        let value = event_json(EventFrame::Snapshot {
            subscription: pragma_constants::ProtocolEventKind::FileChanged,
            payload: serde_json::json!([]),
        });
        assert_eq!(value["type"], "snapshot");
    }
}
