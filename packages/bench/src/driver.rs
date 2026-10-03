//! Talks to the app's Tauri dev bridge (`apps/pragma/src-tauri/src/dev_bridge.rs`).
//!
//! Every interaction with the running app goes through this one place, and
//! always to one specific pid's bridge: a developer commonly has more than one
//! Tauri dev build open, and picking the wrong bridge would drive a
//! benchmark's keystrokes into somebody's real editor.
//!
//! The pid is shared and re-resolvable rather than fixed, because Tauri's dev
//! watcher restarts the app during a normal run (see `bridge`). When a call
//! finds no bridge, the driver re-locates the app in its own process tree and
//! tries once more; the caller only sees an error if that fails too.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::bridge::{self, BridgeToken};
use crate::error::{BenchError, BenchResult};

/// Prefix the dev bridge puts on an exception it caught while evaluating.
const ERROR_PREFIX: &str = "ERROR: ";

/// Ceiling on one bridge call. The bridge gives up on an `eval` after five
/// seconds and answers 504, so anything beyond this is a wedged app.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait for the bridge's listener to accept a connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub struct Driver {
    /// Pid of the app's bridge. Shared so a re-resolve is seen by every clone.
    app_pid: Arc<AtomicU32>,
    /// Pid of the `bun run dev` supervisor, used to re-find the app.
    dev_pid: u32,
    /// Bridges that predate this run and must never be adopted.
    foreign: Arc<Vec<u32>>,
}

impl Driver {
    #[must_use]
    pub fn new(app_pid: Arc<AtomicU32>, dev_pid: u32, foreign: Arc<Vec<u32>>) -> Self {
        Self {
            app_pid,
            dev_pid,
            foreign,
        }
    }

    /// The pid currently being driven.
    #[must_use]
    pub fn app_pid(&self) -> u32 {
        self.app_pid.load(Ordering::SeqCst)
    }

    /// Evaluates JavaScript (an expression, or an IIFE) in the app's main window.
    pub fn eval(&self, js: &str) -> BenchResult<Value> {
        self.run(js)
    }

    /// Calls a Tauri command by name, as the frontend would.
    pub fn invoke(&self, command: &str, args: &Value) -> BenchResult<Value> {
        let js = format!(
            "window.__TAURI_INTERNALS__.invoke({}, {})",
            json!(command),
            args
        );
        self.run(&js)
    }

    /// Re-resolves which app to drive. Returns the new pid when it changed.
    pub fn relocate(&self) -> Option<u32> {
        let found = bridge::locate(self.dev_pid, &self.foreign)?;
        let previous = self.app_pid.swap(found.pid, Ordering::SeqCst);
        (previous != found.pid).then_some(found.pid)
    }

    fn run(&self, js: &str) -> BenchResult<Value> {
        match self.attempt(js) {
            Err(BenchError::BridgeGone) => {
                // The app was replaced mid-run. Adopt its successor and repeat
                // the call once; a second failure is reported as itself.
                let Some(pid) = self.relocate() else {
                    return Err(BenchError::BridgeGone);
                };
                println!("\n  dev app restarted; now driving pid {pid}");
                self.attempt(js)
            }
            other => other,
        }
    }

    fn attempt(&self, js: &str) -> BenchResult<Value> {
        let token = bridge::for_pid(self.app_pid()).ok_or(BenchError::BridgeGone)?;
        let body = json!({ "js": js, "token": token.token }).to_string();
        let (status, response) = post(&token, "/eval", &body)?;
        if status != 200 {
            return Err(BenchError::Command {
                command: "dev bridge /eval".to_string(),
                status: status.to_string(),
                stderr: response.trim().to_string(),
            });
        }
        let envelope: Value = serde_json::from_str(&response)?;
        decode_result(envelope.get("result").cloned().unwrap_or(Value::Null))
    }
}

/// Unwraps the bridge's `result`. It returns objects JSON-encoded and
/// everything else as a bare string, so an unparseable payload is a value, not
/// a failure; a caught exception arrives as an `ERROR: ` string.
fn decode_result(result: Value) -> BenchResult<Value> {
    let Value::String(text) = result else {
        return Ok(result);
    };
    if let Some(message) = text.strip_prefix(ERROR_PREFIX) {
        return Err(BenchError::Eval(message.to_string()));
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

/// One HTTP/1.1 POST to the bridge's loopback listener. The bridge answers
/// with a `Content-Length` and the request asks it to close, so reading to EOF
/// yields exactly one response. A refused connection means the app is gone.
fn post(token: &BridgeToken, path: &str, body: &str) -> BenchResult<(u16, String)> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, token.port));
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
        .map_err(|_| BenchError::BridgeGone)?;
    stream.set_read_timeout(Some(CALL_TIMEOUT))?;
    stream.set_write_timeout(Some(CALL_TIMEOUT))?;
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n\
         Content-Length: {length}\r\nConnection: close\r\n\r\n{body}",
        port = token.port,
        length = body.len(),
    )?;
    let mut raw = Vec::new();
    if let Err(error) = stream.read_to_end(&mut raw) {
        if matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ) {
            return Err(BenchError::Timeout {
                what: format!("the dev bridge to answer {path}"),
                waited: CALL_TIMEOUT,
            });
        }
        return Err(BenchError::BridgeGone);
    }
    parse_response(&String::from_utf8_lossy(&raw))
}

fn parse_response(raw: &str) -> BenchResult<(u16, String)> {
    let malformed = || BenchError::Setup(format!("malformed dev bridge response: {raw:.200}"));
    let (head, body) = raw.split_once("\r\n\r\n").ok_or_else(malformed)?;
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(malformed)?;
    Ok((status, body.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relocating_reports_only_an_actual_change() {
        let pid = std::process::id();
        let driver = Driver::new(Arc::new(AtomicU32::new(pid)), pid, Arc::new(vec![pid]));
        // The excluded pid is the only candidate, so there is nothing to adopt.
        assert_eq!(driver.relocate(), None);
        assert_eq!(driver.app_pid(), pid);
    }

    #[test]
    fn a_pid_without_a_bridge_is_reported_as_gone() {
        let driver = Driver::new(Arc::new(AtomicU32::new(1)), 1, Arc::new(vec![1]));
        assert!(matches!(driver.eval("1"), Err(BenchError::BridgeGone)));
    }

    #[test]
    fn results_decode_json_strings_and_errors() {
        assert_eq!(
            decode_result(Value::String("{\"a\":1}".into())).unwrap(),
            json!({ "a": 1 })
        );
        assert_eq!(
            decode_result(Value::String("complete".into())).unwrap(),
            json!("complete")
        );
        assert!(matches!(
            decode_result(Value::String("ERROR: boom".into())),
            Err(BenchError::Eval(message)) if message == "boom"
        ));
        assert_eq!(decode_result(Value::Null).unwrap(), Value::Null);
    }

    #[test]
    fn responses_split_into_status_and_body() {
        let (status, body) =
            parse_response("HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 3\r\n\r\nbad").unwrap();
        assert_eq!(status, 504);
        assert_eq!(body, "bad");
        assert!(parse_response("garbage").is_err());
    }
}
