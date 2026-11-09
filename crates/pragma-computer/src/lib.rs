//! Native computer use for Pragma: accessibility snapshots, screen capture,
//! and synthetic input, behind one [`ComputerBackend`] trait.
//!
//! This crate runs inside the `pragma-computer` helper process, never inside
//! `pragma-server` or the desktop app. A hung accessibility call or a crash in
//! native code then costs one in-flight action, not every terminal session, and
//! the helper has a stable identity for the OS permission prompts. The server
//! supervises the helper and speaks [`protocol`] to it over the helper's
//! standard streams; sessions, leases, policy, and the activity stream are the
//! server's, and none of them live here.
//!
//! Platform code sits in `macos/` (Accessibility, `CGEvent`, `NSWorkspace`);
//! window listing, displays, and capture go through `xcap` on every platform
//! (`capture.rs`). A platform without a backend answers every call with an
//! explicit `unsupportedPlatform` failure, never an empty result.

// Every fallible call here returns the shared `ComputerFailure` wire type,
// whose message, hint, and details map make it larger than clippy's 128-byte
// threshold. Failures are the cold path and are serialized to JSON at once;
// boxing each one would cost every call site a conversion for no gain.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use pragma_constants::{
    ComputerApp, ComputerAppsRequest, ComputerClickRequest, ComputerDisplay, ComputerDragRequest,
    ComputerElement, ComputerErrorCode, ComputerFailure, ComputerFocusRequest,
    ComputerInspectRequest, ComputerKeyRequest, ComputerMethod, ComputerMoveRequest,
    ComputerOpenRequest, ComputerPermissions, ComputerPermissionsRequest, ComputerPoint,
    ComputerScreenshot, ComputerScreenshotRequest, ComputerScrollRequest, ComputerSnapshot,
    ComputerTypeRequest, ComputerWindow, ComputerWindowsRequest,
};
pub use pragma_core::computer::UserActivity;
use serde::{Deserialize, Serialize};

#[cfg(feature = "native")]
pub mod capture;
pub mod fake;
#[cfg(all(feature = "native", target_os = "macos"))]
mod macos;
pub mod protocol;
pub mod serve;
pub mod snapshot;
mod unsupported;
#[cfg(all(feature = "native", target_os = "windows"))]
mod windows;

pub use pragma_core::computer::failure;

/// Result type for every backend call.
pub type ComputerResult<T> = Result<T, ComputerFailure>;

/// The emergency-stop latch, checked between every synthetic event.
///
/// Shared between the request reader and the worker that performs actions, so
/// a `stop` line takes effect mid-`type` without waiting for the action to end.
#[derive(Debug, Clone, Default)]
pub struct StopFlag {
    global: Arc<AtomicBool>,
    sessions: Arc<Mutex<HashMap<String, Arc<AtomicU64>>>>,
    scope: Option<(Arc<AtomicU64>, u64)>,
    target_pid: Option<u64>,
    native_activity: bool,
}

impl StopFlag {
    /// Enables physical takeover probes in the native helper, never fake backends.
    #[must_use]
    pub fn native() -> Self {
        Self {
            native_activity: true,
            ..Self::default()
        }
    }

    /// Latches the stop.
    pub fn trip(&self) {
        self.global.store(true, Ordering::SeqCst);
    }

    /// Clears the latch so actions may run again.
    pub fn clear(&self) {
        self.global.store(false, Ordering::SeqCst);
    }

    /// True while the stop is latched.
    #[must_use]
    pub fn is_tripped(&self) -> bool {
        self.global.load(Ordering::SeqCst)
    }

    /// Pauses one session without interrupting input in other sessions.
    pub fn set_session_paused(&self, session: &str, paused: bool) {
        if let Ok(mut sessions) = self.sessions.lock() {
            let epoch = sessions.entry(session.to_string()).or_default();
            let current = epoch.load(Ordering::SeqCst);
            // Odd epochs are paused. Resuming never revives an older action.
            if (current % 2 == 1) != paused {
                epoch.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    /// Captures the session generation for one native action.
    #[must_use]
    pub fn for_session(&self, session: &str, pid: Option<u64>) -> Self {
        let epoch = self
            .sessions
            .lock()
            .ok()
            .map(|mut sessions| Arc::clone(sessions.entry(session.to_string()).or_default()));
        Self {
            scope: epoch.map(|epoch| {
                let generation = epoch.load(Ordering::SeqCst);
                (epoch, generation)
            }),
            target_pid: pid,
            ..self.clone()
        }
    }

    /// Fails when stopped, paused, superseded, or the user takes over the target.
    /// Native backends call this between input events.
    pub fn check(&self) -> ComputerResult<()> {
        if self.is_tripped() {
            Err(failure(
                ComputerErrorCode::Stopped,
                "computer use was stopped by the user",
            ))
        } else if self.scope.as_ref().is_some_and(|(epoch, generation)| {
            generation % 2 == 1 || epoch.load(Ordering::SeqCst) != *generation
        }) {
            Err(failure(
                ComputerErrorCode::UserTakeover,
                "User paused or stopped the task. Please ask the user to resume or restart.",
            ))
        } else if self.native_activity && self.target_pid.is_some_and(native_user_takeover) {
            Err(failure(ComputerErrorCode::UserTakeover,
                "Task paused: the user clicked or pressed a key in the target app. Please ask the user to resume."))
        } else {
            Ok(())
        }
    }
}

fn native_user_takeover(pid: u64) -> bool {
    #[cfg(all(feature = "native", target_os = "macos"))]
    let activity = Some(macos::user_activity(Some(pid)));
    #[cfg(all(feature = "native", target_os = "windows"))]
    let activity = windows::user_activity(Some(pid));
    #[cfg(not(all(feature = "native", any(target_os = "macos", target_os = "windows"))))]
    let activity: Option<UserActivity> = {
        let _ = pid;
        None
    };
    activity
        .as_ref()
        .is_some_and(pragma_core::computer::is_user_takeover)
}

/// What every backend call can see besides its request.
#[derive(Debug, Clone)]
pub struct Context {
    /// The emergency-stop latch.
    pub stop: StopFlag,
    /// Owner-only directory screenshots are written to by default.
    pub screenshots_dir: PathBuf,
}

/// The app (and window) an `open` or `focus` ended on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Focused {
    pub app: ComputerApp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<ComputerWindow>,
}

/// A request to resolve what an action would touch, before it runs.
///
/// The server resolves first so it can take the right app lease, check the
/// policy against the real target, and show the overlay cursor at the right
/// place before anything moves.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point: Option<ComputerPoint>,
}

/// What an action would touch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub app: ComputerApp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<ComputerWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<ComputerElement>,
    /// Where the pointer would go, when the action has a point.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point: Option<ComputerPoint>,
    /// True when another app's window covers `point` (the action still
    /// reaches the target, in the background).
    #[serde(default)]
    pub covered: bool,
}

/// How an action was performed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Performed {
    pub method: ComputerMethod,
    pub physical_cursor: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<ComputerElement>,
}

/// One platform's computer-use implementation.
///
/// Calls arrive one at a time on the helper's main thread, so platform
/// handles need not be `Send`. Every method that
/// posts more than one synthetic event checks [`Context::stop`] between them.
pub trait ComputerBackend {
    /// OS grants for this process, optionally showing the OS prompt.
    fn permissions(
        &mut self,
        request: &ComputerPermissionsRequest,
    ) -> ComputerResult<ComputerPermissions>;
    /// Attached displays.
    fn displays(&mut self) -> ComputerResult<Vec<ComputerDisplay>>;
    /// Running apps, or installed ones.
    fn apps(&mut self, request: &ComputerAppsRequest) -> ComputerResult<Vec<ComputerApp>>;
    /// Top-level windows, optionally of one app.
    fn windows(&mut self, request: &ComputerWindowsRequest) -> ComputerResult<Vec<ComputerWindow>>;
    /// Launches or re-activates an app.
    fn open(&mut self, ctx: &Context, request: &ComputerOpenRequest) -> ComputerResult<Focused>;
    /// Activates an app or a window.
    fn focus(&mut self, ctx: &Context, request: &ComputerFocusRequest) -> ComputerResult<Focused>;
    /// An accessibility snapshot.
    fn inspect(&mut self, request: &ComputerInspectRequest) -> ComputerResult<ComputerSnapshot>;
    /// A capture, written to a file. A display or region capture leaves out
    /// every window of `hide_pids`.
    fn screenshot(
        &mut self,
        ctx: &Context,
        request: &ComputerScreenshotRequest,
        hide_pids: &[u64],
    ) -> ComputerResult<ComputerScreenshot>;
    /// What an action would touch.
    fn resolve(&mut self, request: &ResolveRequest) -> ComputerResult<Resolved>;
    /// Clicks an element or a point.
    fn click(&mut self, ctx: &Context, request: &ComputerClickRequest)
        -> ComputerResult<Performed>;
    /// Types caller-supplied text.
    fn type_text(
        &mut self,
        ctx: &Context,
        request: &ComputerTypeRequest,
    ) -> ComputerResult<Performed>;
    /// Presses chords.
    fn key(&mut self, ctx: &Context, request: &ComputerKeyRequest) -> ComputerResult<Performed>;
    /// Scrolls.
    fn scroll(
        &mut self,
        ctx: &Context,
        request: &ComputerScrollRequest,
    ) -> ComputerResult<Performed>;
    /// Moves the pointer.
    fn move_pointer(
        &mut self,
        ctx: &Context,
        request: &ComputerMoveRequest,
    ) -> ComputerResult<Performed>;
    /// Drags between two points or elements.
    fn drag(&mut self, ctx: &Context, request: &ComputerDragRequest) -> ComputerResult<Performed>;
    /// What the user is physically (not synthetically) doing relative to the
    /// app `pid`, for takeover detection. `None` when the platform cannot tell.
    fn user_activity(&mut self, pid: Option<u64>) -> Option<UserActivity>;
}

/// Re-runs the helper as its own macOS TCC identity (see `macos/responsible.rs`).
///
/// Returns the exit code to exit with when this process only waited on the
/// re-run, or `None` when it should serve. Always `None` off macOS.
#[cfg(feature = "native")]
#[must_use]
pub fn run_as_own_identity() -> Option<i32> {
    #[cfg(target_os = "macos")]
    {
        macos::run_as_own_identity()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// The backend for the platform this binary was built for.
#[cfg(feature = "native")]
#[must_use]
pub fn native_backend() -> Box<dyn ComputerBackend> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacBackend::new())
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WindowsBackend::new())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Box::new(unsupported::UnsupportedBackend)
    }
}

/// The platform name reported in [`ComputerPermissions::platform`].
#[must_use]
pub fn platform_name() -> &'static str {
    std::env::consts::OS
}

#[cfg(test)]
mod stop_tests {
    use super::*;

    #[test]
    fn session_pause_interrupts_only_its_own_action_and_resume_does_not_revive_it() {
        let stop = StopFlag::default();
        let action = stop.for_session("one", None);
        let other = stop.for_session("two", None);
        assert!(action.check().is_ok());
        stop.set_session_paused("one", true);
        assert_eq!(
            action.check().unwrap_err().code,
            ComputerErrorCode::UserTakeover
        );
        assert!(other.check().is_ok());
        assert!(stop.for_session("one", None).check().is_err());
        stop.set_session_paused("one", false);
        assert!(action.check().is_err());
        assert!(stop.for_session("one", None).check().is_ok());
        stop.trip();
        assert_eq!(other.check().unwrap_err().code, ComputerErrorCode::Stopped);
    }
}
