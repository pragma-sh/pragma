//! The host's computer-use engine: one `computer` RPC and one
//! `computerActivity` stream, with `pragma-cli computer`, `client.computer`,
//! and the desktop as callers of the same code.
//!
//! The native work happens in the supervised `pragma-computer` helper
//! ([`helper`]); this module owns everything around it: who may act
//! ([`policy`]), sessions and leases ([`sessions`]), and the activity every
//! caller sees ([`activity`]). Every mutating action follows one pipeline:
//! resolve the target → refuse blocked apps → authorize the caller (asking the
//! desktop user when the policy says `ask`) → approve sensitive controls →
//! take the app lease → take the input mutex when needed → announce the
//! pointer → act → record.

// Every fallible call here returns the shared `ComputerFailure` wire type,
// which is larger than clippy's threshold; failures are the cold path and
// are serialized at once (see the same allow in `pragma-computer`).
#![allow(clippy::result_large_err)]

pub mod activity;
mod cursor;
mod decide;
pub mod helper;
pub mod policy;
pub mod sessions;
pub mod tasks;

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pragma_computer::protocol::HelperOp;
use pragma_computer::{Focused, Performed, ResolveRequest, Resolved};
use pragma_constants::{
    ComputerAccess, ComputerActionResult, ComputerActivitySnapshot, ComputerActivityType,
    ComputerApp, ComputerApproval, ComputerApproveRequest, ComputerAppsRequest, ComputerCaller,
    ComputerCallerKind, ComputerClickRequest, ComputerDragRequest, ComputerEndRequest,
    ComputerErrorCode, ComputerFailure, ComputerFocusRequest, ComputerFrameRequest,
    ComputerImageFormat, ComputerInputLock, ComputerInspectRequest, ComputerKeyRequest,
    ComputerMethod, ComputerMoveRequest, ComputerOp, ComputerOpenRequest, ComputerPauseReason,
    ComputerPermissionState, ComputerPermissions, ComputerPermissionsRequest, ComputerPoint,
    ComputerPointer, ComputerScreenshot, ComputerScreenshotRequest, ComputerScrollRequest,
    ComputerSession, ComputerSessionRequest, ComputerSnapshot, ComputerTarget, ComputerTypeRequest,
    ComputerUseSettings, ComputerWindowsRequest, CONSTANTS,
};
use pragma_core::computer::{
    app_key, caller_label, command_spec, failure, image_to_screen, is_blocked, is_enabled,
    is_sensitive_label, is_user_takeover, owner_key, redact_text, truncate_label, AppIdentity,
    CursorAnchor, TrackedCursor, UserActivity,
};
use pragma_protocol::EventFrame;
use serde::Deserialize;

use self::activity::{event, ActivityBus};
use self::helper::Helper;
use self::policy::{Policy, Verdict};
use self::sessions::{InputMutex, Sessions};

/// What the computer engine needs from the rest of the host.
pub trait ComputerHost: Send + Sync {
    /// Whether a desktop app is connected to show the active-control indicator.
    fn desktop_connected(&self) -> bool;
    /// The agent reporting from `tab_id`, if any.
    fn agent_for_tab(&self, tab_id: &str) -> Option<String>;
}

/// One `computer` RPC: an attributed caller plus one operation.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerRequest {
    #[serde(default)]
    pub caller: Option<ComputerCaller>,
    #[serde(default)]
    task: Option<tasks::TaskGuard>,
    #[serde(flatten)]
    pub op: ComputerOpRequest,
}

/// The operation, tagged by `op`. Names match the CLI verbs and the SDK.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum ComputerOpRequest {
    Apps(ComputerAppsRequest),
    Windows(ComputerWindowsRequest),
    Displays,
    Open(ComputerOpenRequest),
    Focus(ComputerFocusRequest),
    Inspect(ComputerInspectRequest),
    Screenshot(ComputerScreenshotRequest),
    Click(ComputerClickRequest),
    Type(ComputerTypeRequest),
    Key(ComputerKeyRequest),
    Scroll(ComputerScrollRequest),
    Move(ComputerMoveRequest),
    Drag(ComputerDragRequest),
    Status,
    End(ComputerEndRequest),
    Permissions(ComputerPermissionsRequest),
    Frame(ComputerFrameRequest),
    FocusSession(ComputerSessionRequest),
    Approve(ComputerApproveRequest),
    Pause(ComputerSessionRequest),
    Unpause(ComputerSessionRequest),
    Stop(ComputerSessionRequest),
    Run(pragma_constants::ComputerRunRequest),
    Resume(pragma_constants::ComputerResumeRequest),
    Cancel(pragma_constants::ComputerTaskRequest),
    Task(pragma_constants::ComputerTaskRequest),
}

impl ComputerOpRequest {
    fn op(&self) -> ComputerOp {
        match self {
            Self::Apps(_) => ComputerOp::Apps,
            Self::Windows(_) => ComputerOp::Windows,
            Self::Displays => ComputerOp::Displays,
            Self::Open(_) => ComputerOp::Open,
            Self::Focus(_) | Self::FocusSession(_) => ComputerOp::Focus,
            Self::Inspect(_) => ComputerOp::Inspect,
            Self::Screenshot(_) => ComputerOp::Screenshot,
            Self::Click(_) => ComputerOp::Click,
            Self::Type(_) => ComputerOp::Type,
            Self::Key(_) => ComputerOp::Key,
            Self::Scroll(_) => ComputerOp::Scroll,
            Self::Move(_) => ComputerOp::Move,
            Self::Drag(_) => ComputerOp::Drag,
            Self::Status => ComputerOp::Status,
            Self::End(_) => ComputerOp::End,
            Self::Permissions(_) => ComputerOp::Permissions,
            Self::Frame(_) => ComputerOp::Frame,
            Self::Approve(_) => ComputerOp::Approve,
            Self::Pause(_) => ComputerOp::Pause,
            Self::Unpause(_) => ComputerOp::Unpause,
            Self::Stop(_) => ComputerOp::Stop,
            Self::Run(_) => ComputerOp::Run,
            Self::Resume(_) => ComputerOp::Resume,
            Self::Cancel(_) => ComputerOp::Cancel,
            Self::Task(_) => ComputerOp::Task,
        }
    }
}

/// One planned mutating action: what it targets, how it is worded in the
/// activity stream, how it expects to act, and the helper call that does it.
pub struct Action {
    target: ResolveRequest,
    verb: String,
    method: Option<ComputerMethod>,
    helper_op: HelperOp,
}

/// A request reached a dispatcher that does not handle it: a routing bug.
fn misrouted(request: &ComputerOpRequest) -> ComputerFailure {
    failure(
        ComputerErrorCode::Internal,
        format!("`{:?}` was routed to the wrong handler", request.op()),
    )
}

/// Agents work in the background: an agent's app is never brought to the
/// front, whatever the request asks. Only the desktop user's own navigation
/// (the picture-in-picture arrow) activates an app.
fn keep_in_background(op: &mut ComputerOpRequest) {
    match op {
        ComputerOpRequest::Open(request) => request.activate = Some(false),
        ComputerOpRequest::Focus(request) => request.activate = Some(false),
        _ => {}
    }
}

/// Milliseconds since the Unix epoch.
#[must_use]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Screenshots kept for `click --screenshot` image-space coordinates.
const SHOT_MEMORY: usize = 64;
/// Extra time a helper call may take beyond the shipped per-action bound.
const CALL_SLACK: Duration = Duration::from_secs(2);
/// How often anchored overlay cursors are re-placed against their windows.
const CURSOR_TRACK_INTERVAL: Duration = Duration::from_millis(150);

/// The computer-use engine.
pub struct ComputerService {
    helper: Arc<dyn Helper>,
    sessions: Mutex<Sessions>,
    input: InputMutex,
    policy: Policy,
    activity: Arc<ActivityBus>,
    stopped: AtomicBool,
    /// Owners the desktop user allowed "for this session".
    session_grants: Mutex<HashSet<String>>,
    shots: Mutex<VecDeque<(String, ComputerPoint, f64)>>,
    cursors: cursor::CursorTracker,
    /// Helper calls in flight; cursor tracking never queues behind one.
    busy: AtomicUsize,
    home: Option<PathBuf>,
    screenshots_dir: PathBuf,
    tasks: tasks::Tasks,
    task_host: Mutex<Option<std::sync::Weak<dyn ComputerHost>>>,
}

impl ComputerService {
    /// The engine for a host whose state lives in `server_dir`, with the real
    /// supervised helper.
    pub fn new(server_dir: &std::path::Path) -> Arc<Self> {
        let activity = Arc::new(ActivityBus::default());
        let listener = {
            let activity = Arc::clone(&activity);
            Arc::new(move |status| {
                let mut helper_event = event(ComputerActivityType::HelperState);
                helper_event.helper = Some(status);
                activity.emit(helper_event);
            })
        };
        let helper = Arc::new(helper::ProcessHelper::new(
            server_dir.join(&CONSTANTS.computer.screenshots_directory),
            listener,
        ));
        Self::with_helper(
            server_dir,
            helper,
            activity,
            pragma_core::process_env::home_dir(),
        )
    }

    /// The engine over any helper; tests pass an in-process fake.
    pub fn with_helper(
        server_dir: &std::path::Path,
        helper: Arc<dyn Helper>,
        activity: Arc<ActivityBus>,
        home: Option<PathBuf>,
    ) -> Arc<Self> {
        Arc::new(Self {
            tasks: tasks::Tasks::load(server_dir),
            task_host: Mutex::new(None),
            helper,
            sessions: Mutex::new(Sessions::default()),
            input: InputMutex::default(),
            policy: Policy::load(server_dir),
            activity,
            stopped: AtomicBool::new(false),
            session_grants: Mutex::new(HashSet::new()),
            shots: Mutex::new(VecDeque::new()),
            cursors: cursor::CursorTracker::default(),
            busy: AtomicUsize::new(0),
            home,
            screenshots_dir: server_dir.join(&CONSTANTS.computer.screenshots_directory),
        })
    }

    /// Ends sessions that have sat idle past their timeout, every few seconds.
    pub fn start_sweeper(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            let Some(service) = weak.upgrade() else {
                return;
            };
            service.sweep_idle(now_ms());
            service.sweep_screenshots(std::time::SystemTime::now());
        });
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(CURSOR_TRACK_INTERVAL);
            let Some(service) = weak.upgrade() else {
                return;
            };
            service.check_user_takeover();
            service.track_cursors();
        });
    }

    /// Keeps each live session's overlay cursor on its target window as the
    /// window moves, closes, or is covered between actions (see [`cursor`]).
    fn track_cursors(&self) {
        let live: HashSet<String> = self
            .sessions
            .lock()
            .map(|s| s.all().into_iter().map(|session| session.id).collect())
            .unwrap_or_default();
        if self.cursors.retain(|id| live.contains(id))
            || self.stopped.load(Ordering::SeqCst)
            || self.busy.load(Ordering::SeqCst) > 0
        {
            return;
        }
        let request = ComputerWindowsRequest {
            app: None,
            pid: None,
        };
        let Ok(windows) = self
            .helper_call(HelperOp::Windows(request))
            .and_then(from_value::<Vec<pragma_constants::ComputerWindow>>)
        else {
            return;
        };
        for (session_id, pointer) in self.cursors.update(&windows) {
            let mut moved = event(ComputerActivityType::CursorMoved);
            moved.session_id = Some(session_id);
            moved.pointer = Some(pointer);
            self.activity.emit(moved);
        }
    }

    /// Makes the host available to background tasks without a reference cycle.
    pub fn attach_host<H: ComputerHost + 'static>(&self, host: &Arc<H>) {
        let host: Arc<dyn ComputerHost> = host.clone();
        if let Ok(mut slot) = self.task_host.lock() {
            *slot = Some(Arc::downgrade(&host));
        }
    }

    /// Deletes screenshots older than the shipped TTL. Callers that need one
    /// longer copy it out (or pass `--out`).
    fn sweep_screenshots(&self, now: std::time::SystemTime) {
        let ttl = Duration::from_millis(CONSTANTS.computer.screenshot_ttl_ms.get());
        let Ok(entries) = std::fs::read_dir(&self.screenshots_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let expired = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age > ttl);
            if expired {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    fn settings(&self) -> ComputerUseSettings {
        policy::load_settings(self.home.as_deref())
    }

    fn sweep_idle(&self, now: u64) {
        let idle_ms = self.settings().idle_timeout_ms.map_or(
            CONSTANTS.computer.idle_timeout_ms.get(),
            std::num::NonZero::get,
        );
        let idle = self
            .sessions
            .lock()
            .map(|s| s.idle(now, idle_ms))
            .unwrap_or_default();
        for id in idle {
            self.end_session(&id, "idle");
        }
    }

    /// Ends every session a tab owns: the tab closed, or its agent finished.
    pub fn end_tab(&self, tab_id: &str) {
        self.tasks.cancel_tab(tab_id);
        let ids = self
            .sessions
            .lock()
            .map(|s| s.of_tab(tab_id))
            .unwrap_or_default();
        for id in ids {
            self.end_session(&id, "owner finished");
        }
    }

    fn end_session(&self, id: &str, why: &str) -> Option<ComputerSession> {
        self.tasks.cancel_session(id);
        self.sessions.lock().ok()?.by_id(id)?;
        // Invalidate the session's helper generation before its leases go,
        // so input still running (a long `type`) stops instead of outliving
        // the session and its indicator. Session ids are never reused.
        self.helper.set_session_paused(id, true);
        let ended = self.sessions.lock().ok()?.end(id)?;
        if let Ok(mut grants) = self.session_grants.lock() {
            grants.remove(&owner_key(&ended.owner));
        }
        let mut ended_event = event(ComputerActivityType::SessionEnded);
        ended_event.session_id = Some(ended.id.clone());
        ended_event.caller = Some(ended.owner.clone());
        ended_event.description = Some(why.to_string());
        ended_event.session = Some(ended.clone());
        self.activity.emit(ended_event);
        Some(ended)
    }

    /// The live picture, for `status` and the stream snapshot.
    pub fn snapshot(&self, host: &dyn ComputerHost) -> ComputerActivitySnapshot {
        ComputerActivitySnapshot {
            enabled: is_enabled(&self.settings()),
            desktop_connected: host.desktop_connected(),
            sessions: self.sessions.lock().map(|s| s.all()).unwrap_or_default(),
            approvals: self.policy.pending(),
            helper: self.helper.status(),
            stopped: self.stopped.load(Ordering::SeqCst),
            last_seq: self.activity.last_seq(),
            tasks: self.tasks.all(),
        }
    }

    /// Subscribes to `computerActivity`.
    pub fn subscribe(
        &self,
        host: &dyn ComputerHost,
    ) -> (Vec<EventFrame>, std::sync::mpsc::Receiver<EventFrame>) {
        self.activity
            .subscribe(|| serde_json::to_value(self.snapshot(host)).unwrap_or_default())
    }

    /// Dispatches one `computer` RPC.
    pub fn handle_rpc(
        self: &Arc<Self>,
        host: &dyn ComputerHost,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, ComputerFailure> {
        let request: ComputerRequest = serde_json::from_value(payload).map_err(|error| {
            failure(
                ComputerErrorCode::InvalidPayload,
                format!("invalid computer request: {error}"),
            )
        })?;
        let caller = resolve_caller(host, request.caller);
        self.tasks.check_guard(&caller, request.task.as_ref())?;
        if caller.kind != ComputerCallerKind::User
            && !matches!(
                request.op,
                ComputerOpRequest::Status
                    | ComputerOpRequest::Task(_)
                    | ComputerOpRequest::Permissions(_)
                    | ComputerOpRequest::Cancel(_)
            )
        {
            self.check_caller_session(&caller)?;
        }
        let task_guard = request.task;
        let op = request.op.op();
        let mut operation = request.op;
        if caller.kind != ComputerCallerKind::User {
            keep_in_background(&mut operation);
        }
        if command_spec(op).desktop_only && caller.kind != ComputerCallerKind::User {
            return Err(failure(
                ComputerErrorCode::NotAuthorized,
                "only the Pragma desktop app can do that",
            ));
        }
        match operation {
            request @ (ComputerOpRequest::Run(_)
            | ComputerOpRequest::Resume(_)
            | ComputerOpRequest::Cancel(_)
            | ComputerOpRequest::Task(_)) => self.task_rpc(host, &caller, request),
            ComputerOpRequest::Open(input) => {
                self.ensure_permission_setup(host, &caller, op)?;
                self.open(host, &caller, input, task_guard.as_ref())
            }
            request @ (ComputerOpRequest::Apps(_)
            | ComputerOpRequest::Windows(_)
            | ComputerOpRequest::Displays
            | ComputerOpRequest::Inspect(_)
            | ComputerOpRequest::Screenshot(_)) => {
                self.ensure_permission_setup(host, &caller, op)?;
                self.read(host, &caller, op, request)
            }
            request @ (ComputerOpRequest::Focus(_)
            | ComputerOpRequest::Click(_)
            | ComputerOpRequest::Type(_)
            | ComputerOpRequest::Key(_)
            | ComputerOpRequest::Scroll(_)
            | ComputerOpRequest::Move(_)
            | ComputerOpRequest::Drag(_)) => {
                self.ensure_permission_setup(host, &caller, op)?;
                let action = self.plan(request)?;
                self.act(host, &caller, op, action, task_guard.as_ref())
            }
            request => self.control(host, &caller, request),
        }
    }

    /// The read-only operations: authorized, but needing no desktop and no lease.
    fn read(
        &self,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        op: ComputerOp,
        request: ComputerOpRequest,
    ) -> Result<serde_json::Value, ComputerFailure> {
        self.authorize_read(host, caller, op)?;
        match request {
            ComputerOpRequest::Apps(request) => {
                let mut apps: Vec<ComputerApp> =
                    from_value(self.helper_call(HelperOp::Apps(request))?)?;
                let extra = self.settings().blocked_apps;
                for app in &mut apps {
                    app.blocked = Some(is_blocked(&identity(app), &extra));
                }
                to_value(&apps)
            }
            ComputerOpRequest::Windows(request) => self.helper_call(HelperOp::Windows(request)),
            ComputerOpRequest::Displays => self.helper_call(HelperOp::Displays),
            ComputerOpRequest::Inspect(request) => {
                let snapshot: ComputerSnapshot =
                    from_value(self.helper_call(HelperOp::Inspect(request))?)?;
                self.refuse_blocked(&snapshot.app)?;
                to_value(&snapshot)
            }
            ComputerOpRequest::Screenshot(mut request) => {
                let hide_pids = self.guard_capture(&mut request)?;
                let shot: ComputerScreenshot =
                    from_value(self.helper_call(HelperOp::Screenshot { request, hide_pids })?)?;
                self.remember_shot(&shot);
                to_value(&shot)
            }
            other => Err(misrouted(&other)),
        }
    }

    /// Refuses a screenshot of a blocked app, checking the target the backends
    /// actually capture (a region, else a display, else a window, else an
    /// app's window), and names the processes a screen capture leaves out.
    /// A request naming nothing captures the primary display on every
    /// platform, so it never falls back to whichever window has focus.
    fn guard_capture(
        &self,
        request: &mut ComputerScreenshotRequest,
    ) -> Result<Vec<u64>, ComputerFailure> {
        if request.region.is_none() && request.display.is_none() {
            if let Some(window) = &request.window {
                self.refuse_blocked_window(window, request.app.as_ref(), request.pid)?;
                return Ok(Vec::new());
            }
            if request.app.is_some() || request.pid.is_some() {
                let resolved = self.resolve(ResolveRequest {
                    app: request.app.clone(),
                    pid: request.pid,
                    ..ResolveRequest::default()
                })?;
                self.refuse_blocked(&resolved.app)?;
                return Ok(Vec::new());
            }
            let displays: Vec<pragma_constants::ComputerDisplay> =
                from_value(self.helper_call(HelperOp::Displays)?)?;
            request.display = displays
                .into_iter()
                .find(|display| display.primary)
                .map(|display| display.id);
        }
        self.blocked_pids()
    }

    /// Refuses a capture of `window` when a blocked app owns it, or when it
    /// is not the window of the app the request also names.
    fn refuse_blocked_window(
        &self,
        window: &str,
        app: Option<&String>,
        pid: Option<u64>,
    ) -> Result<(), ComputerFailure> {
        let windows: Vec<pragma_constants::ComputerWindow> =
            from_value(self.helper_call(HelperOp::Windows(ComputerWindowsRequest {
                app: None,
                pid: None,
            }))?)?;
        let owner = windows
            .iter()
            .find(|listed| listed.id == window)
            .map(|listed| listed.pid)
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::WindowNotFound,
                    format!("no on-screen window `{window}`"),
                )
            })?;
        let resolved = self.resolve(ResolveRequest {
            pid: Some(owner),
            ..ResolveRequest::default()
        })?;
        self.refuse_blocked(&resolved.app)?;
        if app.is_some() || pid.is_some() {
            let named = self.resolve(ResolveRequest {
                app: app.cloned(),
                pid,
                ..ResolveRequest::default()
            })?;
            if named.app.pid != Some(owner) {
                return Err(failure(
                    ComputerErrorCode::InvalidPayload,
                    format!("window `{window}` does not belong to {}", named.app.name),
                ));
            }
        }
        Ok(())
    }

    /// Running apps agents may not read, by process.
    fn blocked_pids(&self) -> Result<Vec<u64>, ComputerFailure> {
        let apps: Vec<ComputerApp> =
            from_value(self.helper_call(HelperOp::Apps(ComputerAppsRequest {
                installed: None,
                query: None,
            }))?)?;
        let extra = self.settings().blocked_apps;
        Ok(apps
            .iter()
            .filter(|app| is_blocked(&identity(app), &extra))
            .filter_map(|app| app.pid)
            .collect())
    }

    /// Turns a mutating request into the target, wording, and helper call the
    /// action pipeline runs.
    fn plan(&self, request: ComputerOpRequest) -> Result<Action, ComputerFailure> {
        Ok(match request {
            ComputerOpRequest::Focus(request) => {
                let target = ResolveRequest {
                    app: request.app.clone(),
                    pid: request.pid,
                    window: request.window.clone(),
                    ..ResolveRequest::default()
                };
                let description = if request.activate == Some(true) {
                    "Bring to front"
                } else {
                    "Focus"
                }
                .to_string();
                Action {
                    target,
                    verb: description,
                    method: None,
                    helper_op: HelperOp::Focus(request),
                }
            }
            ComputerOpRequest::Click(mut request) => {
                self.map_image_point(&mut request)?;
                let target = target_of(
                    request.app.as_ref(),
                    request.pid,
                    request.element.as_ref(),
                    request.x,
                    request.y,
                );
                let method = request.method;
                Action {
                    target,
                    verb: "Click".to_string(),
                    method,
                    helper_op: HelperOp::Click(request),
                }
            }
            ComputerOpRequest::Type(request) => {
                let target = target_of(
                    request.app.as_ref(),
                    request.pid,
                    request.element.as_ref(),
                    None,
                    None,
                );
                let description = format!("Type {}", redact_text(&request.text));
                let method = request.method;
                Action {
                    target,
                    verb: description,
                    method,
                    helper_op: HelperOp::Type(request),
                }
            }
            ComputerOpRequest::Key(request) => {
                let target = target_of(request.app.as_ref(), request.pid, None, None, None);
                let description = format!("Press {}", request.chords.join(" "));
                Action {
                    target,
                    verb: description,
                    method: Some(ComputerMethod::Keys),
                    helper_op: HelperOp::Key(request),
                }
            }
            other => return Self::plan_pointer(other),
        })
    }

    /// [`Self::plan`] for the operations that aim the pointer at a place.
    fn plan_pointer(request: ComputerOpRequest) -> Result<Action, ComputerFailure> {
        Ok(match request {
            ComputerOpRequest::Scroll(request) => {
                let target = target_of(
                    request.app.as_ref(),
                    request.pid,
                    request.element.as_ref(),
                    request.x,
                    request.y,
                );
                let description = format!(
                    "Scroll {}",
                    serde_json::to_value(request.direction)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_default()
                );
                Action {
                    target,
                    verb: description,
                    method: Some(ComputerMethod::Pointer),
                    helper_op: HelperOp::Scroll(request),
                }
            }
            ComputerOpRequest::Move(request) => {
                let target = target_of(
                    request.app.as_ref(),
                    request.pid,
                    request.element.as_ref(),
                    request.x,
                    request.y,
                );
                let method = if request.visual_only == Some(true) {
                    Some(ComputerMethod::Ax)
                } else {
                    Some(ComputerMethod::Pointer)
                };
                Action {
                    target,
                    verb: "Point".to_string(),
                    method,
                    helper_op: HelperOp::Move(request),
                }
            }
            ComputerOpRequest::Drag(request) => {
                let from = pragma_core::computer::parse_point(&request.from);
                let target = ResolveRequest {
                    app: request.app.clone(),
                    pid: request.pid,
                    element: from.is_none().then(|| request.from.clone()),
                    point: from,
                    ..ResolveRequest::default()
                };
                Action {
                    target,
                    verb: "Drag".to_string(),
                    method: Some(ComputerMethod::Pointer),
                    helper_op: HelperOp::Drag(request),
                }
            }
            other => return Err(misrouted(&other)),
        })
    }

    /// Status, diagnostics, and the desktop's controls.
    fn control(
        &self,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        request: ComputerOpRequest,
    ) -> Result<serde_json::Value, ComputerFailure> {
        match request {
            ComputerOpRequest::Status => to_value(&self.snapshot(host)),
            ComputerOpRequest::Permissions(request) => {
                self.helper_call(HelperOp::Permissions(request))
            }
            ComputerOpRequest::End(request) => {
                self.tasks.cancel_owner(caller);
                self.policy.deny_caller(caller);
                for task in self
                    .tasks
                    .all()
                    .into_iter()
                    .filter(|t| owner_key(&t.owner) == owner_key(caller))
                {
                    self.task_event(&task);
                }
                let id = match (&request.session, caller.kind) {
                    (Some(id), ComputerCallerKind::User) => Some(id.clone()),
                    _ => self
                        .sessions
                        .lock()
                        .ok()
                        .and_then(|s| s.of(caller).map(|s| s.id.clone())),
                };
                let ended = id.and_then(|id| self.end_session(&id, "ended"));
                Ok(serde_json::json!({ "ended": ended.is_some(), "session": ended }))
            }
            // Frames are screenshots; only the desktop's PiP may pull them.
            ComputerOpRequest::Frame(request) if caller.kind == ComputerCallerKind::User => {
                self.frame(&request)
            }
            ComputerOpRequest::Frame(_) => Err(failure(
                ComputerErrorCode::NotAuthorized,
                "only the Pragma desktop app can read session frames",
            )),
            ComputerOpRequest::FocusSession(request) => self.focus_session(host, caller, &request),
            ComputerOpRequest::Approve(request) => {
                let approval = self.policy.answer(&request.approval, request.decision)?;
                let mut resolved = event(ComputerActivityType::ApprovalResolved);
                resolved.caller = Some(approval.caller.clone());
                resolved.approval = Some(approval);
                resolved.description = serde_json::to_value(request.decision)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string));
                self.activity.emit(resolved);
                Ok(serde_json::Value::Null)
            }
            ComputerOpRequest::Pause(request) => {
                self.set_paused(request.session.as_deref(), Some(ComputerPauseReason::User));
                Ok(serde_json::Value::Null)
            }
            ComputerOpRequest::Unpause(request) => {
                if self.stopped.swap(false, Ordering::SeqCst) {
                    self.helper.set_stopped(false);
                }
                self.set_paused(request.session.as_deref(), None);
                Ok(serde_json::Value::Null)
            }
            ComputerOpRequest::Stop(request) => {
                // With a session, Stop ends that one (the PiP's Stop button);
                // without, it is the emergency stop for everything.
                match request.session {
                    Some(id) => {
                        self.set_paused(Some(&id), Some(ComputerPauseReason::Stopped));
                        if let Ok(mut sessions) = self.sessions.lock() {
                            sessions.stop(&id);
                        }
                        self.tasks.cancel_session(&id);
                        for task in self
                            .tasks
                            .all()
                            .iter()
                            .filter(|t| t.session_id.as_deref() == Some(&id))
                        {
                            self.task_event(task);
                        }
                    }
                    None => self.stop(),
                }
                Ok(serde_json::Value::Null)
            }
            other => Err(misrouted(&other)),
        }
    }

    /// The emergency stop: latch, deny every prompt, end every session.
    pub fn stop(&self) {
        self.tasks.cancel_all();
        for task in self.tasks.all() {
            self.task_event(&task);
        }
        self.stopped.store(true, Ordering::SeqCst);
        self.helper.set_stopped(true);
        self.policy.deny_all();
        let ended = self
            .sessions
            .lock()
            .map(|mut s| s.end_all())
            .unwrap_or_default();
        if let Ok(mut grants) = self.session_grants.lock() {
            grants.clear();
        }
        for session in ended {
            let mut ended_event = event(ComputerActivityType::SessionEnded);
            ended_event.session_id = Some(session.id.clone());
            ended_event.caller = Some(session.owner.clone());
            ended_event.description = Some("stopped".to_string());
            ended_event.session = Some(session);
            self.activity.emit(ended_event);
        }
        self.activity.emit(event(ComputerActivityType::Stopped));
    }

    fn set_paused(&self, session: Option<&str>, reason: Option<ComputerPauseReason>) {
        let changed = self
            .sessions
            .lock()
            .map(|mut s| s.set_paused(session, reason))
            .unwrap_or_default();
        if session.is_none() && reason.is_some() && reason != Some(ComputerPauseReason::Stopped) {
            for task in self.tasks.pause(None) {
                self.task_event(&task);
            }
        }
        for session in changed {
            self.helper
                .set_session_paused(&session.id, reason.is_some());
            if reason.is_some() {
                self.policy.deny_caller(&session.owner);
                if reason == Some(ComputerPauseReason::Stopped) {
                    self.tasks.cancel_owner(&session.owner);
                } else {
                    for task in self.tasks.pause(Some(&session.owner)) {
                        self.task_event(&task);
                    }
                }
            }
            let kind = if reason.is_some() {
                ComputerActivityType::SessionPaused
            } else {
                ComputerActivityType::SessionResumed
            };
            let mut paused = event(kind);
            paused.session_id = Some(session.id.clone());
            paused.caller = Some(session.owner.clone());
            paused.session = Some(session);
            self.activity.emit(paused);
        }
    }

    fn helper_call(&self, op: HelperOp) -> Result<serde_json::Value, ComputerFailure> {
        let timeout = timeout_for(&op);
        self.busy.fetch_add(1, Ordering::SeqCst);
        let result = self.helper.call(op, timeout);
        self.busy.fetch_sub(1, Ordering::SeqCst);
        result
    }

    fn resolve(&self, request: ResolveRequest) -> Result<Resolved, ComputerFailure> {
        from_value(self.helper_call(HelperOp::Resolve(request))?)
    }

    fn refuse_blocked(&self, app: &ComputerApp) -> Result<(), ComputerFailure> {
        if is_blocked(&identity(app), &self.settings().blocked_apps) {
            let mut blocked = failure(
                ComputerErrorCode::BlockedApp,
                format!("{} cannot be controlled or read by agents", app.name),
            );
            blocked.hint = Some("Pragma itself, password managers, and system security prompts are always off limits.".to_string());
            return Err(blocked);
        }
        Ok(())
    }

    fn remember_shot(&self, shot: &ComputerScreenshot) {
        if let Ok(mut shots) = self.shots.lock() {
            if shots.len() >= SHOT_MEMORY {
                shots.pop_front();
            }
            shots.push_back((shot.id.clone(), shot.origin.clone(), shot.scale));
        }
    }

    /// Turns `imageX`/`imageY` on a screenshot into screen coordinates, so a
    /// caller doing vision on a screenshot never maps pixels itself.
    fn map_image_point(&self, request: &mut ComputerClickRequest) -> Result<(), ComputerFailure> {
        let (Some(image_x), Some(image_y)) = (request.image_x, request.image_y) else {
            return Ok(());
        };
        let id = request.screenshot.as_deref().ok_or_else(|| {
            failure(
                ComputerErrorCode::InvalidPayload,
                "imageX/imageY need --screenshot <id>",
            )
        })?;
        let (origin, scale) = self
            .shots
            .lock()
            .ok()
            .and_then(|shots| {
                shots
                    .iter()
                    .find(|(shot, _, _)| shot == id)
                    .map(|(_, origin, scale)| (origin.clone(), *scale))
            })
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::SnapshotExpired,
                    format!("screenshot `{id}` is not known; take a new one"),
                )
            })?;
        let point = image_to_screen(&origin, scale, image_x, image_y);
        request.x = Some(point.x);
        request.y = Some(point.y);
        request.image_x = None;
        request.image_y = None;
        request.screenshot = None;
        Ok(())
    }

    // -------------------------------------------------------------- policy

    /// Let the desktop collect missing OS grants before resolving any native
    /// target, including for callers already allowed by Pragma's access policy.
    fn ensure_permission_setup(
        &self,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        op: ComputerOp,
    ) -> Result<(), ComputerFailure> {
        if caller.kind == ComputerCallerKind::User || !host.desktop_connected() {
            return Ok(());
        }
        let settings = self.require_enabled()?;
        if self.policy.access(&settings, caller) == ComputerAccess::Deny {
            return Err(failure(
                ComputerErrorCode::NotAuthorized,
                format!(
                    "{} is not allowed to use the computer",
                    caller_label(caller)
                ),
            ));
        }
        if command_spec(op).mutating {
            self.preflight(host)?;
        }
        let permissions: ComputerPermissions = from_value(
            self.helper_call(HelperOp::Permissions(ComputerPermissionsRequest::default()))?,
        )?;
        if permissions.supported
            && permissions.platform == "macos"
            && (permissions.accessibility != ComputerPermissionState::Granted
                || permissions.screen_recording != ComputerPermissionState::Granted)
        {
            self.request_access(host, caller, op, None, None)?;
        }
        Ok(())
    }

    fn require_enabled(&self) -> Result<ComputerUseSettings, ComputerFailure> {
        let settings = self.settings();
        if is_enabled(&settings) {
            return Ok(settings);
        }
        let mut disabled = failure(ComputerErrorCode::Disabled, "computer use is turned off");
        disabled.hint = Some("Turn it on in Pragma under Settings → Computer Use.".to_string());
        Err(disabled)
    }

    fn authorize_read(
        &self,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        op: ComputerOp,
    ) -> Result<(), ComputerFailure> {
        let settings = self.require_enabled()?;
        self.authorize(host, &settings, caller, op, None, None)
    }

    /// Checks the caller against the policy, asking the desktop user when it
    /// says `ask` and no grant covers this owner yet.
    fn authorize(
        &self,
        host: &dyn ComputerHost,
        settings: &ComputerUseSettings,
        caller: &ComputerCaller,
        op: ComputerOp,
        session_id: Option<&str>,
        target: Option<&ComputerTarget>,
    ) -> Result<(), ComputerFailure> {
        if caller.kind == ComputerCallerKind::User {
            return Ok(());
        }
        match self.policy.access(settings, caller) {
            ComputerAccess::Allow => Ok(()),
            ComputerAccess::Deny => Err(failure(
                ComputerErrorCode::NotAuthorized,
                format!(
                    "{} is not allowed to use the computer",
                    caller_label(caller)
                ),
            )),
            ComputerAccess::Ask => {
                let key = owner_key(caller);
                if self
                    .session_grants
                    .lock()
                    .is_ok_and(|grants| grants.contains(&key))
                {
                    return Ok(());
                }
                self.request_access(host, caller, op, session_id, target)
            }
        }
    }

    /// Ask for caller access, remembering a session answer for subsequent calls.
    fn request_access(
        &self,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        op: ComputerOp,
        session_id: Option<&str>,
        target: Option<&ComputerTarget>,
    ) -> Result<(), ComputerFailure> {
        let reason = format!("{} wants to use your computer", caller_label(caller));
        let approval = approval_for(caller, op, session_id, target, reason, false);
        match self.ask(host, &approval)? {
            Verdict::Allowed {
                remember_for_session,
            } => {
                if remember_for_session {
                    if let Ok(mut grants) = self.session_grants.lock() {
                        grants.insert(owner_key(caller));
                    }
                }
                Ok(())
            }
            Verdict::Denied => Err(failure(ComputerErrorCode::Denied, "the user declined")),
        }
    }

    /// Asks the desktop user, blocking until they answer.
    fn ask(
        &self,
        host: &dyn ComputerHost,
        approval: &ComputerApproval,
    ) -> Result<Verdict, ComputerFailure> {
        if !host.desktop_connected() {
            let mut offline = failure(
                ComputerErrorCode::NotAuthorized,
                "computer use needs approval in Pragma, which is not running",
            );
            offline.hint = Some(
                "Open Pragma and try again, or allow this agent under Settings → Computer Use."
                    .to_string(),
            );
            return Err(offline);
        }
        let activity = Arc::clone(&self.activity);
        for task in self.tasks.approval_state(&approval.caller, true) {
            self.task_event(&task);
        }
        let verdict = self.policy.wait_for(approval, |approval| {
            let mut requested = event(ComputerActivityType::ApprovalRequested);
            requested.caller = Some(approval.caller.clone());
            requested.session_id.clone_from(&approval.session_id);
            requested.op = Some(approval.op);
            requested.target.clone_from(&approval.target);
            requested.approval = Some(approval.clone());
            activity.emit(requested);
        });
        for task in self.tasks.approval_state(&approval.caller, false) {
            self.task_event(&task);
        }
        // An answer resolves the prompt through `approve`; one nobody answered
        // has to be withdrawn here, or the desktop keeps showing a prompt the
        // host has already given up on.
        if verdict.is_err() {
            let mut expired = event(ComputerActivityType::ApprovalResolved);
            expired.caller = Some(approval.caller.clone());
            expired.approval = Some(approval.clone());
            expired.description = Some("expired".to_string());
            self.activity.emit(expired);
        }
        verdict
    }

    // -------------------------------------------------------------- actions

    fn preflight(&self, host: &dyn ComputerHost) -> Result<ComputerUseSettings, ComputerFailure> {
        if self.stopped.load(Ordering::SeqCst) {
            let mut stopped = failure(
                ComputerErrorCode::Stopped,
                "User stopped computer use. Please ask the user to resume or restart.",
            );
            stopped.hint = Some(
                "Ask the user to resume computer use in Pragma before restarting the task."
                    .to_string(),
            );
            return Err(stopped);
        }
        let settings = self.require_enabled()?;
        if !host.desktop_connected() {
            let mut offline = failure(
                ComputerErrorCode::IndicatorUnavailable,
                "controlling apps needs the Pragma desktop app open, so the user can see and stop it",
            );
            offline.hint = Some("Open Pragma, then retry.".to_string());
            return Err(offline);
        }
        Ok(settings)
    }

    /// Enforces the desktop pause/restart latch for every caller, including fresh CLI calls.
    fn check_caller_session(&self, caller: &ComputerCaller) -> Result<(), ComputerFailure> {
        let session = self
            .sessions
            .lock()
            .ok()
            .and_then(|s| s.of(caller).cloned());
        if let Some(session) = session.filter(|s| s.paused) {
            let stopped = session.pause_reason == Some(ComputerPauseReason::Stopped);
            return Err(failure(
                if stopped {
                    ComputerErrorCode::Stopped
                } else {
                    ComputerErrorCode::UserTakeover
                },
                if stopped {
                    "User stopped the task. Please ask the user to restart in Pragma."
                } else {
                    "User paused the task. Please ask the user to resume in Pragma."
                },
            ));
        }
        Ok(())
    }

    /// Refuses to dispatch for a session that ended (closed tab, `end`, idle)
    /// after the action began: a caller with no session is otherwise fine.
    fn require_live_session(&self, session: &str) -> Result<(), ComputerFailure> {
        let live = self
            .sessions
            .lock()
            .map_err(|_| failure(ComputerErrorCode::Internal, "session lock poisoned"))?
            .by_id(session)
            .is_some();
        if live {
            Ok(())
        } else {
            Err(failure(
                ComputerErrorCode::Stopped,
                "The computer-use session ended before the action ran.",
            ))
        }
    }

    /// Detects takeover between actions too, including while a model is deciding.
    fn check_user_takeover(&self) {
        if self.busy.load(Ordering::SeqCst) > 0 || self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let sessions = self.sessions.lock().map(|s| s.all()).unwrap_or_default();
        for session in sessions.iter().filter(|s| !s.paused) {
            for lease in &session.leases {
                let activity: Option<UserActivity> = self
                    .helper_call(HelperOp::UserActivity { pid: lease.pid })
                    .ok()
                    .and_then(|value| serde_json::from_value(value).ok());
                if activity.as_ref().is_some_and(is_user_takeover) {
                    self.set_paused(Some(&session.id), Some(ComputerPauseReason::Takeover));
                    break;
                }
            }
        }
    }

    /// Refuses to act while the user is physically working in `app`: typing
    /// into it, or clicking or scrolling in its window. Input in other apps,
    /// and pointer movement alone, never count.
    fn refuse_if_user_active(
        &self,
        app: &ComputerApp,
        session: &str,
    ) -> Result<(), ComputerFailure> {
        let activity: Option<UserActivity> = self
            .helper_call(HelperOp::UserActivity { pid: app.pid })
            .ok()
            .and_then(|value| serde_json::from_value(value).ok());
        let Some(activity) = activity.filter(is_user_takeover) else {
            return Ok(());
        };
        // Name which reading tripped it: a refusal that only says "working in
        // X" cannot be told apart from the agent's own input being misread.
        let why = if activity.target_frontmost
            && activity
                .keyboard_seconds
                .is_some_and(|s| s < pragma_core::computer::TAKEOVER_WINDOW_SECONDS)
        {
            "typing while it is the frontmost app"
        } else {
            "clicking or scrolling in its window"
        };
        self.set_paused(Some(session), Some(ComputerPauseReason::Takeover));
        let mut refused = failure(
            ComputerErrorCode::UserTakeover,
            format!(
                "Task paused: the user is working in {} ({why}). Please ask the user to resume.",
                app.name
            ),
        );
        if let Ok(serde_json::Value::Object(readings)) = serde_json::to_value(&activity) {
            refused.details.extend(readings);
        }
        Err(refused)
    }

    fn open(
        &self,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        request: ComputerOpenRequest,
        task: Option<&tasks::TaskGuard>,
    ) -> Result<serde_json::Value, ComputerFailure> {
        let settings = self.preflight(host)?;
        let name = request.app.clone().unwrap_or_default();
        // Refuse a blocked app by name before launching it, and again by the
        // identity it actually launched as.
        let named = AppIdentity {
            bundle_id: request.app.as_deref(),
            path: request.app.as_deref(),
            name: &name,
        };
        if is_blocked(&named, &settings.blocked_apps) {
            return Err(failure(
                ComputerErrorCode::BlockedApp,
                format!("{name} cannot be controlled by agents"),
            ));
        }
        let target = ComputerTarget {
            app_id: None,
            app_name: Some(name.clone()),
            window_id: None,
            element_id: None,
            element_label: None,
            role: None,
        };
        let session = self.begin(host, &settings, caller, ComputerOp::Open, &target)?;
        self.tasks.check_guard(caller, task)?;
        // A running app is leased before launch/focus can affect it.
        if let Ok(resolved) = self.resolve(ResolveRequest {
            app: request.app.clone(),
            pid: request.pid,
            ..ResolveRequest::default()
        }) {
            self.refuse_blocked(&resolved.app)?;
            self.take_lease(&session, &resolved.app)?;
        }
        self.preflight(host)?;
        self.check_caller_session(caller)?;
        self.require_live_session(&session.id)?;
        self.tasks.check_guard(caller, task)?;
        let action_id = self.announce(
            &session,
            ComputerOp::Open,
            &target,
            None,
            format!("Open {name}"),
        );
        let started = std::time::Instant::now();
        let result: Result<Focused, ComputerFailure> = self
            .helper_call(HelperOp::InSession {
                session: session.id.clone(),
                pid: None,
                action: Box::new(HelperOp::Open(request)),
            })
            .and_then(from_value);
        let focused = match result {
            Ok(focused) => focused,
            Err(error) => {
                return Err(self.failed(&session, caller, ComputerOp::Open, &action_id, error))
            }
        };
        if let Err(error) = self.refuse_blocked(&focused.app) {
            return Err(self.failed(&session, caller, ComputerOp::Open, &action_id, error));
        }
        if let Err(error) = self.take_lease(&session, &focused.app) {
            return Err(self.failed(&session, caller, ComputerOp::Open, &action_id, error));
        }
        let performed = Performed {
            method: ComputerMethod::Ax,
            physical_cursor: false,
            element: None,
        };
        let result = self.completed(
            &session,
            caller,
            ComputerOp::Open,
            &action_id,
            &target,
            &performed,
            started,
            format!("Open {}", focused.app.name),
        );
        let mut value = to_value(&result)?;
        value["app"] = to_value(&focused.app)?;
        if let Some(window) = &focused.window {
            value["window"] = to_value(window)?;
        }
        Ok(value)
    }

    /// The mutating-action pipeline shared by every operation but `open`.
    fn act(
        &self,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        op: ComputerOp,
        action: Action,
        task: Option<&tasks::TaskGuard>,
    ) -> Result<serde_json::Value, ComputerFailure> {
        let Action {
            target,
            verb,
            method,
            mut helper_op,
        } = action;
        let settings = self.preflight(host)?;
        let resolved = self.resolve(target)?;
        self.refuse_blocked(&resolved.app)?;
        // The checked, leased app is the one the helper acts on: left
        // unpinned, `key` or `type` would re-resolve "frontmost" when it runs,
        // after approval and queueing gave focus time to move.
        pin_target(&mut helper_op, resolved.app.pid);
        let activity_target = activity_target(&resolved);
        let session = self.begin(host, &settings, caller, op, &activity_target)?;
        self.approve_sensitive(
            host,
            &settings,
            caller,
            op,
            &session,
            &resolved,
            &activity_target,
        )?;
        self.tasks.check_guard(caller, task)?;
        self.take_lease(&session, &resolved.app)?;
        self.refuse_if_user_active(&resolved.app, &session.id)?;
        let spec = command_spec(op);
        let needs_input = match spec.input_lock {
            ComputerInputLock::None => false,
            ComputerInputLock::Always => true,
            ComputerInputLock::Pointer => method != Some(ComputerMethod::Ax),
        };
        let _input = if needs_input {
            Some(self.input.take()?)
        } else {
            None
        };
        let description = match &activity_target.element_label {
            Some(label) if !label.is_empty() => format!("{verb} “{label}”"),
            _ => format!("{verb} in {}", resolved.app.name),
        };
        // The overlay draws the cursor inside the target window only, and
        // hides it where another app covers the point.
        let pointer = action_pointer(&resolved);
        self.anchor_cursor(&session.id, &resolved);
        let action_id = self.announce(&session, op, &activity_target, pointer, description.clone());
        if resolved.point.is_some() {
            // Let the overlay cursor arrive before anything moves.
            std::thread::sleep(Duration::from_millis(CONSTANTS.computer.cursor_lead_ms));
        }
        let started = std::time::Instant::now();
        let outcome: Result<Performed, ComputerFailure> = self
            .tasks
            .check_guard(caller, task)
            .and_then(|()| self.preflight(host))
            .and_then(|_| {
                let focus = matches!(helper_op, HelperOp::Focus(_));
                self.check_caller_session(caller)?;
                self.require_live_session(&session.id)?;
                self.refuse_if_user_active(&resolved.app, &session.id)?;
                let value = self.helper_call(HelperOp::InSession {
                    session: session.id.clone(),
                    pid: resolved.app.pid,
                    action: Box::new(helper_op),
                })?;
                if focus {
                    // `focus` answers with the app and window it ended on.
                    let focused: Focused = from_value(value)?;
                    if focused.app.pid != resolved.app.pid {
                        return Err(failure(
                            ComputerErrorCode::TargetChanged,
                            format!("focus ended on {}, not the leased app", focused.app.name),
                        ));
                    }
                    Ok(Performed {
                        method: ComputerMethod::Ax,
                        physical_cursor: false,
                        element: None,
                    })
                } else {
                    from_value(value)
                }
            });
        match outcome {
            Ok(performed) => {
                let result = self.completed(
                    &session,
                    caller,
                    op,
                    &action_id,
                    &activity_target,
                    &performed,
                    started,
                    description,
                );
                to_value(&result)
            }
            Err(error) => {
                if error.code == ComputerErrorCode::UserTakeover
                    && self.check_caller_session(caller).is_ok()
                {
                    self.set_paused(Some(&session.id), Some(ComputerPauseReason::Takeover));
                }
                Err(self.failed(&session, caller, op, &action_id, error))
            }
        }
    }

    /// Authorizes the caller and opens (or reuses) its session.
    fn begin(
        &self,
        host: &dyn ComputerHost,
        settings: &ComputerUseSettings,
        caller: &ComputerCaller,
        op: ComputerOp,
        target: &ComputerTarget,
    ) -> Result<ComputerSession, ComputerFailure> {
        let existing = self
            .sessions
            .lock()
            .ok()
            .and_then(|s| s.of(caller).cloned());
        self.authorize(
            host,
            settings,
            caller,
            op,
            existing.as_ref().map(|s| s.id.as_str()),
            Some(target),
        )?;
        let session = self.open_session(caller)?;
        self.check_caller_session(caller)?;
        Ok(session)
    }

    /// Opens one visible session for both direct actions and durable tasks.
    fn open_session(&self, caller: &ComputerCaller) -> Result<ComputerSession, ComputerFailure> {
        let (session, new) = self
            .sessions
            .lock()
            .map_err(|_| failure(ComputerErrorCode::Internal, "session lock poisoned"))?
            .open(caller, now_ms());
        if new {
            let mut started = event(ComputerActivityType::SessionStarted);
            started.session_id = Some(session.id.clone());
            started.caller = Some(session.owner.clone());
            started.session = Some(session.clone());
            self.activity.emit(started);
        }
        Ok(session)
    }

    #[allow(clippy::too_many_arguments)]
    fn approve_sensitive(
        &self,
        host: &dyn ComputerHost,
        settings: &ComputerUseSettings,
        caller: &ComputerCaller,
        op: ComputerOp,
        session: &ComputerSession,
        resolved: &Resolved,
        target: &ComputerTarget,
    ) -> Result<(), ComputerFailure> {
        if caller.kind == ComputerCallerKind::User {
            return Ok(());
        }
        let sensitive = settings
            .access
            .as_ref()
            .and_then(|access| access.sensitive)
            .unwrap_or(ComputerAccess::Ask);
        if sensitive == ComputerAccess::Allow {
            return Ok(());
        }
        let Some(element) = &resolved.element else {
            return Ok(());
        };
        let reason = if op == ComputerOp::Click && is_sensitive_label(&element.label) {
            format!(
                "{} wants to click “{}” in {}",
                caller_label(caller),
                truncate_label(&element.label),
                resolved.app.name
            )
        } else if op == ComputerOp::Type && element.secure {
            format!(
                "{} wants to type into a password field in {}",
                caller_label(caller),
                resolved.app.name
            )
        } else {
            return Ok(());
        };
        if sensitive == ComputerAccess::Deny {
            return Err(failure(ComputerErrorCode::NotAuthorized, reason));
        }
        let approval = approval_for(caller, op, Some(&session.id), Some(target), reason, true);
        match self.ask(host, &approval)? {
            Verdict::Allowed { .. } => Ok(()),
            Verdict::Denied => Err(failure(ComputerErrorCode::Denied, "the user declined")),
        }
    }

    fn take_lease(
        &self,
        session: &ComputerSession,
        app: &ComputerApp,
    ) -> Result<(), ComputerFailure> {
        let identifier = app
            .bundle_id
            .as_deref()
            .or(app.path.as_deref())
            .unwrap_or(&app.name);
        let key = app_key(identifier);
        let result = self
            .sessions
            .lock()
            .map_err(|_| failure(ComputerErrorCode::Internal, "session lock poisoned"))?
            .lease(&session.id, &key, &app.name, app.pid, now_ms());
        if let Err(error) = &result {
            let mut denied = event(ComputerActivityType::LeaseDenied);
            denied.session_id = Some(session.id.clone());
            denied.caller = Some(session.owner.clone());
            denied.error = Some(error.clone());
            self.activity.emit(denied);
        }
        result.map(|_| ())
    }

    /// Anchors `session`'s cursor to the window an action is about to act
    /// in, so it keeps following that window until the next pointed action.
    /// Actions with no point (typing, keys) leave it where it was.
    fn anchor_cursor(&self, session: &str, resolved: &Resolved) {
        let Some(point) = &resolved.point else {
            return;
        };
        self.cursors.anchor(
            session,
            resolved.window.as_ref().map(|window| {
                (
                    CursorAnchor::new(&window.id, &window.frame, point),
                    TrackedCursor {
                        point: point.clone(),
                        window: Some(window.frame.clone()),
                        covered: resolved.covered,
                    },
                )
            }),
        );
    }

    fn announce(
        &self,
        session: &ComputerSession,
        op: ComputerOp,
        target: &ComputerTarget,
        pointer: Option<ComputerPointer>,
        description: String,
    ) -> String {
        let action_id = format!("ca_{}", uuid::Uuid::new_v4().simple());
        let mut started = event(ComputerActivityType::ActionStarted);
        started.session_id = Some(session.id.clone());
        started.action_id = Some(action_id.clone());
        started.caller = Some(session.owner.clone());
        started.op = Some(op);
        started.target = Some(target.clone());
        started.pointer = pointer;
        started.description = Some(description);
        self.activity.emit(started);
        action_id
    }

    #[allow(clippy::too_many_arguments)]
    fn completed(
        &self,
        session: &ComputerSession,
        caller: &ComputerCaller,
        op: ComputerOp,
        action_id: &str,
        target: &ComputerTarget,
        performed: &Performed,
        started: std::time::Instant,
        description: String,
    ) -> ComputerActionResult {
        let elapsed = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let touched = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut s| s.touch(&session.id, now_ms(), Some(description.clone())));
        let mut done = event(ComputerActivityType::ActionCompleted);
        done.session_id = Some(session.id.clone());
        done.action_id = Some(action_id.to_string());
        done.caller = Some(caller.clone());
        done.op = Some(op);
        done.target = Some(target.clone());
        done.method = Some(performed.method);
        done.physical_cursor = Some(performed.physical_cursor);
        done.description = Some(description);
        done.session = touched;
        self.activity.emit(done);
        ComputerActionResult {
            session_id: session.id.clone(),
            action_id: action_id.to_string(),
            method: performed.method,
            physical_cursor: performed.physical_cursor,
            elapsed_ms: elapsed,
            app: None,
            window: None,
            element: performed.element.clone(),
        }
    }

    fn failed(
        &self,
        session: &ComputerSession,
        caller: &ComputerCaller,
        op: ComputerOp,
        action_id: &str,
        error: ComputerFailure,
    ) -> ComputerFailure {
        let mut failed = event(ComputerActivityType::ActionFailed);
        failed.session_id = Some(session.id.clone());
        failed.action_id = Some(action_id.to_string());
        failed.caller = Some(caller.clone());
        failed.op = Some(op);
        failed.error = Some(error.clone());
        self.activity.emit(failed);
        error
    }

    /// Desktop navigation preserves the agent's ownership and pause state.
    fn focus_session(
        &self,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        request: &ComputerSessionRequest,
    ) -> Result<serde_json::Value, ComputerFailure> {
        if caller.kind != ComputerCallerKind::User {
            return Err(failure(
                ComputerErrorCode::NotAuthorized,
                "only the Pragma desktop app can focus a session's app",
            ));
        }
        self.preflight(host)?;
        let id = request.session.as_deref().ok_or_else(|| {
            failure(
                ComputerErrorCode::InvalidPayload,
                "a session id is required",
            )
        })?;
        let lease = self.session_lease(id)?;
        let request = ComputerFocusRequest {
            app: lease.pid.is_none().then_some(lease.app_key),
            pid: lease.pid,
            window: None,
            activate: Some(true),
        };
        let resolved = self.resolve(ResolveRequest {
            app: request.app.clone(),
            pid: request.pid,
            ..ResolveRequest::default()
        })?;
        self.refuse_blocked(&resolved.app)?;
        // This is the user's navigation, not an agent action: keep the
        // existing lease, pause state, action count and owner intact.
        self.helper_call(HelperOp::Focus(request))
    }

    /// The app shown by the preview and brought forward by its arrow.
    fn session_lease(&self, id: &str) -> Result<pragma_constants::ComputerLease, ComputerFailure> {
        self.sessions
            .lock()
            .ok()
            .and_then(|s| {
                s.by_id(id)
                    .and_then(|session| session.leases.last().cloned())
            })
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::WindowNotFound,
                    "that session is not controlling an app",
                )
            })
    }

    /// A small JPEG of a session's controlled app for the desktop preview.
    fn frame(&self, request: &ComputerFrameRequest) -> Result<serde_json::Value, ComputerFailure> {
        let lease = self.session_lease(&request.session)?;
        let shot =
            ComputerScreenshotRequest {
                app: if lease.pid.is_some() {
                    None
                } else {
                    Some(lease.app_key.clone())
                },
                pid: lease.pid,
                window: None,
                display: None,
                region: None,
                out: None,
                format: Some(ComputerImageFormat::Jpeg),
                max_width: Some(request.max_width.unwrap_or(
                    std::num::NonZero::new(480).unwrap_or(std::num::NonZero::<u64>::MIN),
                )),
                base64: Some(true),
            };
        let shot: ComputerScreenshot = from_value(self.helper_call(HelperOp::Screenshot {
            request: shot,
            hide_pids: Vec::new(),
        })?)?;
        // The PiP holds the bytes; the file is not needed once read.
        let _ = std::fs::remove_file(&shot.path);
        to_value(&shot)
    }
}

/// A new approval prompt, expiring after the shipped timeout.
fn approval_for(
    caller: &ComputerCaller,
    op: ComputerOp,
    session_id: Option<&str>,
    target: Option<&ComputerTarget>,
    reason: String,
    sensitive: bool,
) -> ComputerApproval {
    let now = now_ms();
    ComputerApproval {
        id: format!("ap_{}", uuid::Uuid::new_v4().simple()),
        caller: caller.clone(),
        session_id: session_id.map(str::to_string),
        op,
        reason,
        sensitive,
        target: target.cloned(),
        requested_at: now,
        expires_at: now + CONSTANTS.computer.approval_timeout_ms.get(),
    }
}

/// Fills in what the host knows about a caller, defaulting to `sdk`.
fn resolve_caller(host: &dyn ComputerHost, caller: Option<ComputerCaller>) -> ComputerCaller {
    let mut caller = caller.unwrap_or(ComputerCaller {
        kind: ComputerCallerKind::Sdk,
        tab_id: None,
        worktree_id: None,
        agent_id: None,
        plugin_id: None,
        label: None,
    });
    if caller.kind == ComputerCallerKind::AgentTab && caller.agent_id.is_none() {
        caller.agent_id = caller
            .tab_id
            .as_deref()
            .and_then(|tab| host.agent_for_tab(tab));
    }
    caller
}

/// Points an action at the process the pipeline checked and leased. A request
/// that already names a different process is the resolver's bug, never a
/// retarget, so its own `pid` is overwritten rather than trusted.
fn pin_target(op: &mut HelperOp, pid: Option<u64>) {
    let Some(pid) = pid else {
        return;
    };
    let slot = match op {
        HelperOp::Focus(request) => &mut request.pid,
        HelperOp::Click(request) => &mut request.pid,
        HelperOp::Type(request) => &mut request.pid,
        HelperOp::Key(request) => &mut request.pid,
        HelperOp::Scroll(request) => &mut request.pid,
        HelperOp::Move(request) => &mut request.pid,
        HelperOp::Drag(request) => &mut request.pid,
        _ => return,
    };
    *slot = Some(pid);
}

/// Describes the resolved target without exposing field contents.
fn activity_target(resolved: &Resolved) -> ComputerTarget {
    let label = resolved
        .element
        .as_ref()
        .map(|element| truncate_label(&element.label));
    ComputerTarget {
        app_id: Some(resolved.app.id.clone()),
        app_name: Some(resolved.app.name.clone()),
        window_id: resolved.window.as_ref().map(|window| window.id.clone()),
        element_id: resolved.element.as_ref().map(|element| element.id.clone()),
        element_label: label.clone(),
        role: resolved
            .element
            .as_ref()
            .map(|element| element.role.clone()),
    }
}

/// Clips the action cursor to its target window, hiding covered points.
fn action_pointer(resolved: &Resolved) -> Option<ComputerPointer> {
    resolved.point.clone().map(|to| ComputerPointer {
        from: None,
        to,
        display_id: None,
        window: resolved.window.as_ref().map(|window| window.frame.clone()),
        // No window of the target under the point: there is nothing to
        // clip the cursor to, and drawn unclipped it would float over
        // whatever app is there, so it is hidden instead.
        covered: Some(resolved.covered || resolved.window.is_none()),
        lead_ms: CONSTANTS.computer.cursor_lead_ms,
    })
}

fn identity(app: &ComputerApp) -> AppIdentity<'_> {
    AppIdentity {
        bundle_id: app.bundle_id.as_deref(),
        path: app.path.as_deref(),
        name: &app.name,
    }
}

fn target_of(
    app: Option<&String>,
    pid: Option<u64>,
    element: Option<&String>,
    x: Option<f64>,
    y: Option<f64>,
) -> ResolveRequest {
    ResolveRequest {
        app: app.cloned(),
        pid,
        window: None,
        element: element.cloned(),
        point: match (x, y) {
            (Some(x), Some(y)) => Some(ComputerPoint { x, y }),
            _ => None,
        },
    }
}

/// The time a helper call may take.
fn timeout_for(op: &HelperOp) -> Duration {
    let action = Duration::from_millis(CONSTANTS.computer.action_timeout_ms.get());
    match op {
        HelperOp::InSession { action, .. } => return timeout_for(action),
        HelperOp::Open(request) => {
            let wait = request
                .wait_ready_ms
                .unwrap_or(CONSTANTS.computer.app_launch_wait_ms.get());
            // A cold `open` first enumerates the Start-menu catalog to resolve a
            // packaged app's AUMID, and only then waits for its window. Budget
            // both, or a slow catalog plus a slow first launch kills a helper
            // that was about to answer.
            Duration::from_millis(wait)
                + Duration::from_millis(CONSTANTS.computer.app_launch_wait_ms.get())
                + action
        }
        // Text is typed one character (a down and an up, ~16 ms) at a time;
        // give it time proportional to its length.
        HelperOp::Type(request) => {
            action
                + Duration::from_millis(
                    u64::try_from(request.text.chars().count()).unwrap_or(0) * 20,
                )
        }
        HelperOp::Drag(request) => action + Duration::from_millis(request.duration_ms.unwrap_or(0)),
        _ => action,
    }
    .saturating_add(CALL_SLACK)
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<serde_json::Value, ComputerFailure> {
    serde_json::to_value(value)
        .map_err(|error| failure(ComputerErrorCode::Internal, error.to_string()))
}

fn from_value<T: serde::de::DeserializeOwned>(
    value: serde_json::Value,
) -> Result<T, ComputerFailure> {
    serde_json::from_value(value).map_err(|error| {
        failure(
            ComputerErrorCode::Internal,
            format!("unexpected helper reply: {error}"),
        )
    })
}

impl ComputerHost for crate::registry::Registry {
    fn desktop_connected(&self) -> bool {
        self.controller_writer().ok().flatten().is_some()
    }

    fn agent_for_tab(&self, tab_id: &str) -> Option<String> {
        crate::registry::Registry::agent_for_tab(self, tab_id)
    }
}

#[cfg(test)]
mod tests;
