//! RPC contracts for session liveness and PTY viewport ownership.
//!
//! A session's grid is shared: the desktop showing a tab and a phone attached
//! to the same session are looking at one PTY. These requests make ownership of
//! that grid explicit and temporary, so the small client can size the terminal
//! to its own screen without permanently reshaping the large one's.

use serde::{Deserialize, Serialize};

/// Session operations served by the host that owns the PTY.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
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
