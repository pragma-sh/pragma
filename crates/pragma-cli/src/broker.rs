//! Broker client: sends a [`Control`](RequestKind::Control) request to the
//! server, which forwards it to the running app (the single controller) and
//! returns the app's [`ControlResult`] reply.
//!
//! If no controller is registered, the server returns a `ControlResult` with
//! the canonical "Pragma is not running" error, which the CLI surfaces as
//! [`CliError::AppNotRunning`](crate::server::CliError::AppNotRunning) so scripts
//! can branch on it.

use pragma_constants::ControlMethod;
use pragma_protocol::{
    read_json_frame, write_json_frame, ControlRequest, ControlResult, RequestFrame, RequestKind,
    ServerFrame,
};
use uuid::Uuid;

use crate::server::{self, CliError, Server};

/// Sends one brokered control request and returns the result payload.
pub fn request(
    method: ControlMethod,
    payload: serde_json::Value,
) -> Result<serde_json::Value, CliError> {
    let Server { mut stream } = server::connect()?;
    let request = RequestFrame {
        request_id: Uuid::new_v4().to_string(),
        kind: RequestKind::Control,
        session_id: None,
        worktree_id: None,
        cwd: None,
        cols: None,
        rows: None,
        data: None,
        rpc: None,
        subscription: None,
        control: Some(ControlRequest { method, payload }),
        control_result: None,
    };
    write_json_frame(&mut stream, &request)?;
    loop {
        let frame = read_json_frame::<ServerFrame>(&mut stream)?;
        match frame {
            ServerFrame::ControlResult(result) => return interpret(result),
            // The server may emit its hello or a stray event first; ignore until
            // the matching ControlResult arrives.
            ServerFrame::Hello(_)
            | ServerFrame::Response(_)
            | ServerFrame::Rpc(_)
            | ServerFrame::Event(_)
            | ServerFrame::Control(_) => {}
        }
    }
}

/// Sends a brokered request with no expected payload (just success/failure).
pub fn request_void(method: ControlMethod, payload: serde_json::Value) -> Result<(), CliError> {
    request(method, payload).map(|_| ())
}

fn interpret(result: ControlResult) -> Result<serde_json::Value, CliError> {
    if !result.ok {
        let message = result
            .error
            .unwrap_or_else(|| "control request failed".to_string());
        if crate::output::is_app_not_running(&message) {
            return Err(CliError::AppNotRunning);
        }
        return Err(CliError::Server(message));
    }
    Ok(result.payload.unwrap_or(serde_json::Value::Null))
}
