//! RPC contracts for session liveness and PTY viewport ownership.
//!
//! A session's grid is shared: the desktop showing a tab and a phone attached
//! to the same session are looking at one PTY. These requests make ownership of
//! that grid explicit and temporary, so the small client can size the terminal
//! to its own screen without permanently reshaping the large one's.

use serde::{Deserialize, Serialize};

/// Session operations served by the host that owns the PTY.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionsRequest {
    /// Reports a session's grid, liveness, and whether its viewport is leased.
    Info { session_id: String },
    /// Takes exclusive ownership of the grid and resizes it to `cols`x`rows`,
    /// capturing the previous size so the host can restore it afterwards.
    AcquireViewport {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    /// Extends a held lease. A holder renews well inside the lease window, so
    /// one lost request on a flaky tunnel does not hand the grid back.
    RenewViewport {
        session_id: String,
        lease_id: String,
    },
    /// Hands the grid back and restores the size its owner last wanted.
    ReleaseViewport {
        session_id: String,
        lease_id: String,
    },
    /// Resizes the grid. With a matching `lease_id` the resize is applied; from
    /// anyone else while a lease is held it is recorded as the size to restore.
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
        #[serde(default)]
        lease_id: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    // The phone leases a session's viewport over the gateway, in camelCase.
    #[test]
    fn reads_camel_case_fields() {
        let request: SessionsRequest = serde_json::from_str(
            r#"{"action":"acquireViewport","sessionId":"s1","cols":80,"rows":24}"#,
        )
        .expect("a client sends camelCase");

        match request {
            SessionsRequest::AcquireViewport {
                session_id,
                cols,
                rows,
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!((cols, rows), (80, 24));
            }
            other => panic!("expected acquireViewport, got {other:?}"),
        }
    }

    #[test]
    fn reads_an_optional_camel_case_lease() {
        let request: SessionsRequest = serde_json::from_str(
            r#"{"action":"resize","sessionId":"s1","cols":80,"rows":24,"leaseId":"l1"}"#,
        )
        .expect("a client sends camelCase");

        match request {
            SessionsRequest::Resize { lease_id, .. } => {
                assert_eq!(lease_id.as_deref(), Some("l1"));
            }
            other => panic!("expected resize, got {other:?}"),
        }
    }
}
