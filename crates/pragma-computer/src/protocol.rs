//! The NDJSON protocol between `pragma-server` and the `pragma-computer`
//! helper, one JSON object per line on the helper's stdin and stdout.
//!
//! Requests carry an `id` the response echoes. The operation payloads are the
//! same `@pragma-sh/constants` request types the `computer` RPC takes, minus
//! the caller (attribution is the server's job), plus a few helper-only
//! operations: `resolve`, `stop`, `clearStop`, `userActivity`, and `ping`. `stop` is
//! handled on the reader thread, so it lands while another action is running.

use pragma_constants::{
    ComputerAppsRequest, ComputerClickRequest, ComputerDragRequest, ComputerFailure,
    ComputerFocusRequest, ComputerInspectRequest, ComputerKeyRequest, ComputerMoveRequest,
    ComputerOpenRequest, ComputerPermissionsRequest, ComputerScreenshotRequest,
    ComputerScrollRequest, ComputerTypeRequest, ComputerWindowsRequest,
};
use serde::{Deserialize, Serialize};

use crate::ResolveRequest;

/// One request line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperRequest {
    pub id: u64,
    #[serde(flatten)]
    pub op: HelperOp,
}

/// One helper operation, tagged by `op`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum HelperOp {
    Ping,
    Permissions(ComputerPermissionsRequest),
    Displays,
    Apps(ComputerAppsRequest),
    Windows(ComputerWindowsRequest),
    Open(ComputerOpenRequest),
    Focus(ComputerFocusRequest),
    Inspect(ComputerInspectRequest),
    Screenshot {
        request: ComputerScreenshotRequest,
        /// Processes whose windows a display or region capture leaves out:
        /// the apps agents may not read. The server decides which they are.
        #[serde(default, rename = "hidePids", skip_serializing_if = "Vec::is_empty")]
        hide_pids: Vec<u64>,
    },
    Resolve(ResolveRequest),
    Click(ComputerClickRequest),
    Type(ComputerTypeRequest),
    Key(ComputerKeyRequest),
    Scroll(ComputerScrollRequest),
    Move(ComputerMoveRequest),
    Drag(ComputerDragRequest),
    /// What the user is physically doing relative to the app `pid`.
    UserActivity {
        #[serde(default)]
        pid: Option<u64>,
    },
    /// Runs an action with a session-scoped cancellation guard.
    InSession {
        session: String,
        pid: Option<u64>,
        action: Box<HelperOp>,
    },
    /// Updates a session guard from the reader thread, even during input.
    SetSessionPaused {
        session: String,
        paused: bool,
    },
    /// Latches the emergency stop. Answered from the reader thread.
    Stop,
    /// Clears the emergency stop.
    ClearStop,
}

impl HelperOp {
    /// True for operations the reader thread answers itself, without queueing
    /// behind a running action.
    #[must_use]
    pub fn is_immediate(&self) -> bool {
        matches!(
            self,
            Self::Stop | Self::ClearStop | Self::Ping | Self::SetSessionPaused { .. }
        )
    }
}

/// One response line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperResponse {
    pub id: u64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ComputerFailure>,
}

impl HelperResponse {
    /// A successful response.
    #[must_use]
    pub fn ok(id: u64, result: serde_json::Value) -> Self {
        Self {
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    /// A failed response.
    #[must_use]
    pub fn err(id: u64, error: ComputerFailure) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

/// The first line the helper prints once it is ready to serve.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperHello {
    pub ready: bool,
    pub pid: u32,
    pub platform: String,
    pub version: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_requests_accept_legacy_and_single_grant_prompts() {
        for (extra, expected) in [
            ("", None),
            (
                r#", "permission":"accessibility""#,
                Some(pragma_constants::ComputerPermissionKind::Accessibility),
            ),
            (
                r#", "permission":"screenRecording""#,
                Some(pragma_constants::ComputerPermissionKind::ScreenRecording),
            ),
        ] {
            let line = format!(r#"{{"id":1,"op":"permissions","request":true{extra}}}"#);
            let request: HelperRequest = serde_json::from_str(&line).unwrap();
            let HelperOp::Permissions(permissions) = request.op else {
                panic!("expected permissions")
            };
            assert_eq!(permissions.request, Some(true));
            assert_eq!(permissions.permission, expected);
        }
    }

    #[test]
    fn requests_round_trip_with_flattened_op() {
        let line = r#"{"id":7,"op":"click","element":"s3:e1","count":2}"#;
        let request: HelperRequest = serde_json::from_str(line).unwrap();
        assert_eq!(request.id, 7);
        let HelperOp::Click(click) = &request.op else {
            panic!("expected click");
        };
        assert_eq!(click.element.as_deref(), Some("s3:e1"));
        let back = serde_json::to_value(&request).unwrap();
        assert_eq!(back["op"], "click");
        assert_eq!(back["id"], 7);
    }

    #[test]
    fn unit_ops_parse() {
        let request: HelperRequest = serde_json::from_str(r#"{"id":1,"op":"stop"}"#).unwrap();
        assert!(request.op.is_immediate());
        let request: HelperRequest = serde_json::from_str(r#"{"id":2,"op":"displays"}"#).unwrap();
        assert!(!request.op.is_immediate());
    }
}
