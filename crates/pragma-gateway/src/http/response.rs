use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use pragma_protocol::{read_frame, EventFrame, Frame, ServerFrame};
use serde::Serialize;
use serde_json::{json, Value};
use tiny_http::{Header, Request, Response, StatusCode};

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

/// How often an idle NDJSON stream emits a `{"type":"ready"}` keepalive line.
/// Public tunnels (ngrok, cloudflared) and other HTTP intermediaries silently
/// drop connections idle for minutes; a sub-minute heartbeat keeps long-lived
/// subscription streams alive and doubles as a dead-client detector.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(20);

/// The keepalive line. Clients treat any line without a known `type` as a
/// heartbeat and ignore it.
const KEEPALIVE_LINE: &[u8] = b"{\"type\":\"ready\"}\n";

/// The HTTP response writer, shared between the event forwarder and the
/// keepalive ticker.
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// Streams an NDJSON response directly to the HTTP writer.
///
/// `tiny_http`'s standard `Read`-based response path buffers chunked bodies and
/// never flushes while `io::copy` is blocked waiting for the next event. This
/// helper takes ownership of the request writer, writes the response headers
/// and a `{"type":"ready"}` heartbeat, then forwards server events as lines
/// and flushes after each one so subscribers see data immediately. A keepalive
/// ticker re-sends the heartbeat every [`KEEPALIVE_INTERVAL`] so idle streams
/// survive tunnel/proxy idle timeouts; when the client is gone the failed
/// keepalive write shuts the server stream down so the forwarder thread exits
/// instead of leaking.
pub fn stream_ndjson_response(request: Request, stream: UnixStream) -> GatewayResult<()> {
    let mut writer = request.into_writer();
    writer.write_all(b"HTTP/1.1 200 OK\r\n")?;
    writer.write_all(b"content-type: application/x-ndjson\r\n")?;
    writer.write_all(b"cache-control: no-cache\r\n")?;
    writer.write_all(b"transfer-encoding: chunked\r\n")?;
    writer.write_all(b"access-control-allow-origin: *\r\n")?;
    writer.write_all(b"access-control-expose-headers: content-type\r\n")?;
    writer.write_all(b"\r\n")?;
    write_chunk(&mut writer, KEEPALIVE_LINE)?;
    writer.flush()?;
    let writer: SharedWriter = Arc::new(Mutex::new(writer));
    let done = Arc::new(AtomicBool::new(false));
    spawn_keepalive(
        Arc::clone(&writer),
        Arc::clone(&done),
        stream.try_clone().ok(),
    );
    thread::spawn(move || {
        forward_stream_to_writer(stream, &writer);
        done.store(true, Ordering::Relaxed);
        finish_chunked_body(&writer);
    });
    Ok(())
}

/// Writes the HTTP/1.1 terminal chunk (`0\r\n\r\n`, RFC 7230 §4.1) once the
/// event stream ends, so clients and buffering proxies see a clean body end
/// instead of a bare connection close. Best-effort: the client may already be
/// gone.
fn finish_chunked_body(writer: &SharedWriter) {
    if let Ok(mut guard) = writer.lock() {
        let _ = write_chunk(&mut **guard, &[]);
        let _ = guard.flush();
    }
}

/// Periodically writes the keepalive line until the forwarder finishes or a
/// write fails. On write failure the client has disconnected: shut the server
/// event stream down so the forwarder's blocking read unblocks and exits.
fn spawn_keepalive(writer: SharedWriter, done: Arc<AtomicBool>, shutdown: Option<UnixStream>) {
    thread::spawn(move || loop {
        thread::sleep(KEEPALIVE_INTERVAL);
        if done.load(Ordering::Relaxed) {
            return;
        }
        let failed = match writer.lock() {
            Ok(mut writer) => {
                // Re-check under the lock: the forwarder may have written the
                // terminal chunk since the sleep, and a keepalive chunk after
                // it would corrupt the chunked body.
                if done.load(Ordering::Relaxed) {
                    return;
                }
                write_chunk(&mut **writer, KEEPALIVE_LINE).is_err() || writer.flush().is_err()
            }
            Err(_) => true,
        };
        if failed {
            if let Some(stream) = &shutdown {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            return;
        }
    });
}

fn forward_stream_to_writer(mut stream: UnixStream, writer: &SharedWriter) {
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
        let Ok(mut guard) = writer.lock() else {
            break;
        };
        if write_chunk(&mut **guard, &line).is_err() || guard.flush().is_err() || is_exit {
            break;
        }
    }
}

fn write_chunk(writer: &mut dyn Write, body: &[u8]) -> std::io::Result<()> {
    write!(writer, "{:X}\r\n", body.len())?;
    writer.write_all(body)?;
    writer.write_all(b"\r\n")
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
            options,
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
            "options": options,
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
        EventFrame::AgentInterrupt { interrupt } => json!({
            "type": "agentInterrupt",
            "interrupt": interrupt,
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

fn json_header() -> Header {
    Header::from_bytes(&b"content-type"[..], &b"application/json"[..]).expect("valid header")
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
    use pragma_protocol::{AgentStatus, EventFrame, QuestionOption};

    use super::{event_json, write_chunk};

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

    #[test]
    fn serializes_question_option_descriptions() {
        let option: QuestionOption = serde_json::from_value(serde_json::json!({
            "label": "Postgres",
            "description": "Client-server relational database",
        }))
        .expect("valid question option");
        let value = event_json(EventFrame::Agent {
            worktree_id: "worktree".to_string(),
            tab_id: "tab".to_string(),
            agent: "cursor".to_string(),
            status: AgentStatus::Attention,
            attention_kind: Some(pragma_constants::AgentAttentionKind::Question),
            command: None,
            question: Some("Which database?".to_string()),
            options: Some(vec![option]),
            request_id: Some("req-1".to_string()),
        });
        assert_eq!(
            value["options"][0]["description"],
            "Client-server relational database"
        );
    }

    #[test]
    fn writes_valid_http_chunk() {
        let mut output = Vec::new();
        write_chunk(&mut output, b"ready\n").expect("chunk should write");
        assert_eq!(output, b"6\r\nready\n\r\n");
    }

    #[test]
    fn empty_chunk_is_the_terminal_chunk() {
        let mut output = Vec::new();
        write_chunk(&mut output, &[]).expect("chunk should write");
        assert_eq!(output, b"0\r\n\r\n");
    }
}
