//! The macOS backend: Accessibility for reading and element actions, `CGEvent`
//! for pointer and keyboard input, `NSWorkspace` for apps, and `xcap` for
//! windows, displays, and capture.
//!
//! Element actions (`AXPress`, setting `AXValue`) are preferred because they
//! work on background windows and never move the physical cursor. Clicks,
//! scrolls, and keys that need real events are delivered to the target
//! process in the background (`background`): the app is not activated, its
//! window is not raised, and the user's pointer does not move. Nothing an
//! agent does brings its app to the front: drags, and clicks the background
//! path cannot address (no window of the app under the point, or the Window
//! Server refusing the focus record), post HID events only when the app is
//! already frontmost and are `targetChanged` otherwise. Only `focus` with
//! `activate` (the desktop user's own navigation) and `open` with `activate`
//! bring an app forward, and the server sets those for the user alone.

mod apps;
mod background;
mod ffi;
mod input;
mod responsible;
mod walk;

use std::time::{Duration, Instant};

use objc2_app_kit::NSApplicationActivationOptions;
use objc2_core_foundation::CGPoint;
use pragma_constants::{
    ComputerApp, ComputerAppsRequest, ComputerClickRequest, ComputerDisplay, ComputerDragRequest,
    ComputerElement, ComputerErrorCode, ComputerFocusRequest, ComputerImageFormat,
    ComputerInspectRequest, ComputerKeyRequest, ComputerMethod, ComputerMouseButton,
    ComputerMoveRequest, ComputerOpenRequest, ComputerPermissionKind, ComputerPermissionState,
    ComputerPermissions, ComputerPermissionsRequest, ComputerPoint, ComputerRect,
    ComputerScreenshot, ComputerScreenshotRequest, ComputerScrollDirection, ComputerScrollRequest,
    ComputerSnapshot, ComputerTypeRequest, ComputerWindow, ComputerWindowsRequest, CONSTANTS,
};
use pragma_core::computer::{
    ax_menu_modifiers, matches_query, parse_chord, parse_point, rect_center, revalidate,
    snapshot_id, visible_center, Chord, ChordPlatform, Key, Modifier, Revalidation,
};

use self::apps::Running;
use self::ffi::Element;
pub(crate) use self::ffi::{capture_image, supports_screen_capture_kit};
pub use self::responsible::run_as_own_identity;
use crate::capture::{self, CaptureOutput, CaptureTarget};
use crate::snapshot::{normalize_role, SnapshotRing, WalkLimits};
use crate::{
    failure, ComputerBackend, ComputerResult, Context, Focused, Performed, ResolveRequest,
    Resolved, UserActivity,
};

/// Seconds any one app may take to answer an accessibility message.
const AX_TIMEOUT_SECONDS: f32 = 1.0;
/// How long activation may take before the target counts as refused.
const ACTIVATE_WAIT: Duration = Duration::from_millis(1500);

/// The macOS backend.
#[derive(Default)]
pub struct MacBackend {
    ring: SnapshotRing<Element>,
}

impl MacBackend {
    /// A backend with an empty snapshot ring.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

fn pid_i32(pid: u64) -> i32 {
    i32::try_from(pid).unwrap_or(0)
}

// ------------------------------------------------------------------ apps

fn matches_app(app: &ComputerApp, query: &str) -> bool {
    let query = query.trim();
    app.name.eq_ignore_ascii_case(query)
        || app.id.eq_ignore_ascii_case(query)
        || app
            .bundle_id
            .as_deref()
            .is_some_and(|id| id.eq_ignore_ascii_case(query))
        || app
            .path
            .as_deref()
            .is_some_and(|path| path.eq_ignore_ascii_case(query))
}

/// The running app a request names (by pid, name, id, bundle id, or path), or
/// the frontmost app when it names none.
fn running_app(app: Option<&str>, pid: Option<u64>) -> ComputerResult<Running> {
    let mut running = apps::running();
    let index = match (pid, app) {
        (Some(pid), _) => running.iter().position(|r| r.app.pid == Some(pid)),
        (None, Some(name)) => running
            .iter()
            .position(|r| matches_app(&r.app, name))
            .or_else(|| {
                // A unique case-insensitive prefix ("text" → TextEdit) is fine; an
                // ambiguous one is not guessed at.
                let lower = name.to_lowercase();
                let hits: Vec<usize> = running
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| r.app.name.to_lowercase().starts_with(&lower))
                    .map(|(index, _)| index)
                    .collect();
                (hits.len() == 1).then(|| hits[0])
            }),
        (None, None) => running.iter().position(|r| r.app.frontmost),
    };
    match index {
        Some(index) => Ok(running.swap_remove(index)),
        None => Err(failure(
            ComputerErrorCode::AppNotFound,
            match (pid, app) {
                (Some(pid), _) => format!("no running app has pid {pid}"),
                (None, Some(name)) => format!("`{name}` is not running; open it first"),
                (None, None) => "no app is frontmost".to_string(),
            },
        )),
    }
}

fn frontmost_pid() -> Option<i32> {
    apps::frontmost_pid()
}

/// Brings `app` to the front and waits until it is.
///
/// macOS 14's cooperative activation can refuse a background process's
/// request, so the AX `AXFrontmost` attribute is set as well; it is honoured
/// under the Accessibility grant.
fn activate(app: &Running) -> ComputerResult<()> {
    let pid = app.handle.processIdentifier();
    if frontmost_pid() == Some(pid) {
        return Ok(());
    }
    if app.handle.isHidden() {
        app.handle.unhide();
    }
    app.handle
        .activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);
    let element = ffi::application(pid);
    ffi::set_timeout(&element, AX_TIMEOUT_SECONDS);
    let _ = ffi::set_bool(&element, "AXFrontmost", true);
    let started = Instant::now();
    while started.elapsed() < ACTIVATE_WAIT {
        if frontmost_pid() == Some(pid) {
            // Give the app a beat to route key focus to its window.
            std::thread::sleep(Duration::from_millis(60));
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    Err(failure(
        ComputerErrorCode::TargetChanged,
        format!("{} did not come to the front", app.app.name),
    ))
}

/// The foreground path's gate: real HID input goes to whatever is in front,
/// and Pragma never brings an agent's app forward to make that the target.
fn require_frontmost(app: &Running) -> ComputerResult<()> {
    if frontmost_pid() == Some(app.handle.processIdentifier()) {
        return Ok(());
    }
    let mut refused = failure(
        ComputerErrorCode::TargetChanged,
        format!(
            "{} is in the background and this needs it in front; agents never bring an app forward",
            app.app.name
        ),
    );
    refused.hint = Some(
        "Use an element id or a point inside one of its windows, which work in the background, or ask the user to bring the app forward.".to_string(),
    );
    Err(refused)
}

// ------------------------------------------------------------------ windows

/// On-screen windows of regular apps, front to back.
///
/// Only layer-0 windows owned by a regular app count; the Window Server's
/// menu bar, the Dock, and status items are system surfaces, not targets.
fn listed_windows(running: &[Running]) -> Vec<ComputerWindow> {
    let front = frontmost_pid();
    let displays = capture::displays().unwrap_or_default();
    let mut focused_taken = false;
    ffi::window_list()
        .into_iter()
        .filter(|info| info.layer == 0 && info.w > 1.0 && info.h > 1.0)
        .filter_map(|info| {
            let pid = u64::try_from(info.pid).ok()?;
            let owner = running.iter().find(|r| r.app.pid == Some(pid))?;
            let frame = ComputerRect {
                x: info.x,
                y: info.y,
                w: info.w,
                h: info.h,
                display_id: display_of(&displays, info.x + info.w / 2.0, info.y + info.h / 2.0),
            };
            // The list is front to back, so the frontmost app's first window
            // is the focused one.
            let focused = !focused_taken && Some(info.pid) == front;
            focused_taken |= focused;
            Some(ComputerWindow {
                id: capture::window_id(info.id),
                app_id: owner.app.id.clone(),
                app_name: owner.app.name.clone(),
                pid,
                title: info.title.unwrap_or_default(),
                frame,
                focused,
                minimized: false,
                on_screen: true,
            })
        })
        .collect()
}

fn contains(info: &ffi::WindowInfo, point: &CGPoint) -> bool {
    point.x >= info.x && point.x < info.x + info.w && point.y >= info.y && point.y < info.y + info.h
}

/// The window of `pid` an action at `point` lands in, even when another
/// window covers it there: `own` (the window an element was read from) when
/// given, else the app's frontmost regular window containing the point.
///
/// An element's own window matters: when two of the app's windows overlap,
/// the frontmost one at the point is not necessarily the element's.
fn window_at(pid: i32, point: &CGPoint, own: Option<u32>) -> Option<ffi::WindowInfo> {
    ffi::window_list().into_iter().find(|info| {
        info.pid == pid
            && info.layer == 0
            && own.is_none_or(|own| info.id == own)
            && contains(info, point)
    })
}

/// The id of the topmost regular window under `point`, whoever owns it.
fn top_window_at(point: &CGPoint) -> Option<u32> {
    ffi::window_list()
        .into_iter()
        .find(|info| info.layer == 0 && contains(info, point))
        .map(|info| info.id)
}

/// The window of `pid` an action at `point` lands in (see [`window_at`]), and
/// whether any other window, the app's own included, covers the point there.
fn pointer_window(
    pid: u64,
    point: &ComputerPoint,
    own: Option<u32>,
) -> (Option<ComputerWindow>, bool) {
    let cg = to_cg(point);
    let Some(info) = window_at(pid_i32(pid), &cg, own) else {
        return (None, false);
    };
    let id = capture::window_id(info.id);
    let window = listed_windows(&apps::running())
        .into_iter()
        .find(|window| window.id == id);
    let covered = top_window_at(&cg) != Some(info.id);
    (window, covered)
}

/// The background-delivery target for a pointer gesture at `point` in `pid`'s
/// window (see [`window_at`]), or `None` when it cannot be delivered there.
fn background_target(
    pid: u64,
    point: &ComputerPoint,
    own: Option<u32>,
) -> Option<background::Target> {
    if !background::available() {
        return None;
    }
    let pid = pid_i32(pid);
    let point = to_cg(point);
    let window = window_at(pid, &point, own);
    background::trace(|| {
        format!(
            "window_at pid={pid} point={point:?} -> {:?}",
            window.as_ref().map(|w| (w.id, w.x, w.y, w.w, w.h))
        )
    });
    let window = window?;
    Some(background::Target {
        pid,
        window: window.id,
        point,
        origin: CGPoint {
            x: window.x,
            y: window.y,
        },
        height: window.h,
    })
}

/// Clicks in the background when it can. `Ok(false)` means it could not and
/// nothing was sent; the caller falls back to activating the app.
fn background_click(
    ctx: &Context,
    pid: u64,
    point: &ComputerPoint,
    own: Option<u32>,
    gesture: (ComputerMouseButton, u32, &[Modifier]),
) -> ComputerResult<bool> {
    let (button, count, held) = gesture;
    let Some(target) = background_target(pid, point, own) else {
        return Ok(false);
    };
    if background::prepare(&target).is_err() {
        return Ok(false);
    }
    background::click(&ctx.stop, &target, button, count, held)?;
    Ok(true)
}

/// A physical input reading, unless it could be one of our own background
/// posts (`own`): those may be counted in the HID system state too.
fn user_seconds(measured: f64, own: Option<f64>) -> Option<f64> {
    match own {
        Some(own) if measured >= own - 0.05 => None,
        _ => Some(measured),
    }
}

/// The pid owning the topmost regular window under `point`, if any.
fn window_owner_at(point: &CGPoint) -> Option<i32> {
    ffi::window_list()
        .into_iter()
        .find(|info| {
            info.layer == 0
                && point.x >= info.x
                && point.x < info.x + info.w
                && point.y >= info.y
                && point.y < info.y + info.h
        })
        .map(|info| info.pid)
}

fn display_of(displays: &[ComputerDisplay], x: f64, y: f64) -> Option<String> {
    let point = ComputerPoint { x, y };
    displays
        .iter()
        .find(|display| pragma_core::computer::rect_contains(&display.frame, &point))
        .map(|display| display.id.clone())
}

fn display_rects() -> Vec<ComputerRect> {
    capture::displays()
        .map(|displays| displays.into_iter().map(|display| display.frame).collect())
        .unwrap_or_default()
}

/// The AX window element a request targets: the one matching `window_id`'s
/// frame and title, else the app's focused or main window, else its first.
fn ax_window(
    app_element: &Element,
    pid: u64,
    window_id: Option<&str>,
) -> ComputerResult<(Element, Option<ComputerWindow>)> {
    let windows = ffi::elements(app_element, "AXWindows");
    let listed: Vec<ComputerWindow> = listed_windows(&apps::running())
        .into_iter()
        .filter(|w| w.pid == pid)
        .collect();
    if let Some(id) = window_id {
        let target = listed.iter().find(|w| w.id == id).ok_or_else(|| {
            failure(
                ComputerErrorCode::WindowNotFound,
                format!("no window `{id}` for that app"),
            )
        })?;
        let element = windows
            .iter()
            .find(|candidate| same_window(candidate, target))
            .cloned()
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::WindowNotFound,
                    format!("window `{id}` has no accessibility element"),
                )
            })?;
        return Ok((element, Some(target.clone())));
    }
    let element = ffi::element(app_element, "AXFocusedWindow")
        .or_else(|| ffi::element(app_element, "AXMainWindow"))
        .or_else(|| windows.first().cloned())
        .ok_or_else(|| {
            failure(
                ComputerErrorCode::WindowNotFound,
                "the app has no open window",
            )
        })?;
    let matched = listed.into_iter().find(|w| same_window(&element, w));
    Ok((element, matched))
}

fn same_window(element: &Element, window: &ComputerWindow) -> bool {
    let (Some(origin), Some(size)) = (ffi::position(element), ffi::size(element)) else {
        return false;
    };
    let close = |a: f64, b: f64| (a - b).abs() <= 2.0;
    close(origin.x, window.frame.x)
        && close(origin.y, window.frame.y)
        && close(size.width, window.frame.w)
        && close(size.height, window.frame.h)
}

// ------------------------------------------------------------------ elements

/// A stored element resolved against the live tree.
struct Live {
    pid: u64,
    /// The native id of the window the element was read from.
    window: Option<u32>,
    handle: Element,
    element: ComputerElement,
}

/// The frames that clip `element` on screen, innermost first: each scroll
/// view around it, then its window.
fn clips_of(element: &Element) -> Vec<ComputerRect> {
    /// Bounds the walk up a pathological tree.
    const MAX_ANCESTORS: usize = 64;
    let mut clips = Vec::new();
    let mut current = ffi::element(element, "AXParent");
    for _ in 0..MAX_ANCESTORS {
        let Some(node) = current else {
            break;
        };
        let role = ffi::string(&node, "AXRole");
        if matches!(role.as_deref(), Some("AXScrollArea" | "AXWindow")) {
            clips.extend(live_frame(&node));
        }
        if role.as_deref() == Some("AXWindow") {
            break;
        }
        current = ffi::element(&node, "AXParent");
    }
    clips
}

fn live_frame(handle: &Element) -> Option<ComputerRect> {
    let origin = ffi::position(handle)?;
    let size = ffi::size(handle)?;
    Some(ComputerRect {
        x: origin.x,
        y: origin.y,
        w: size.width,
        h: size.height,
        display_id: None,
    })
}

fn to_cg(point: &ComputerPoint) -> CGPoint {
    CGPoint {
        x: point.x,
        y: point.y,
    }
}

fn modifiers(names: &[String]) -> ComputerResult<Vec<Modifier>> {
    names
        .iter()
        .map(|name| {
            parse_chord(&format!("{name}+a"), ChordPlatform::Mac)
                .map(|chord| chord.modifiers)
                .map_err(|message| failure(ComputerErrorCode::InvalidPayload, message))
        })
        .collect::<ComputerResult<Vec<_>>>()
        .map(|all| all.into_iter().flatten().collect())
}

impl MacBackend {
    /// Resolves `id` to a live element: the stored handle when it still reads
    /// as the same control, else a fresh walk of its window and §5.3's
    /// revalidation.
    fn live(&mut self, id: &str) -> ComputerResult<Live> {
        let (stored, index) = self.ring.lookup(id)?;
        let pid = stored.pid;
        let element = stored.elements[index].clone();
        let handle = stored.handles[index].clone();
        let window_id = stored.window_id.clone();
        let role = ffi::string(&handle, "AXRole").map(|role| normalize_role(&role));
        if role.as_deref() == Some(element.role.as_str()) {
            let mut element = element;
            element.frame = live_frame(&handle).or(element.frame);
            return Ok(Live {
                pid,
                window: window_id.as_deref().and_then(capture::parse_window_id),
                handle,
                element,
            });
        }
        let app_element = ffi::application(pid_i32(pid));
        ffi::set_timeout(&app_element, AX_TIMEOUT_SECONDS);
        let (window, _) = ax_window(&app_element, pid, window_id.as_deref())?;
        let seq = self.ring.next_seq();
        let walked = walk::walk(
            &window,
            seq,
            &WalkLimits::new(None, None, true),
            &display_rects(),
        );
        match revalidate(&element, &walked.elements) {
            Revalidation::SamePath(found) | Revalidation::Moved(found) => Ok(Live {
                pid,
                window: window_id.as_deref().and_then(capture::parse_window_id),
                handle: walked.handles[found].clone(),
                element: walked.elements[found].clone(),
            }),
            Revalidation::Stale(similar) => {
                let candidates: Vec<serde_json::Value> = similar
                    .iter()
                    .filter_map(|&i| walked.elements.get(i))
                    .map(|candidate| serde_json::json!({ "label": candidate.label, "role": candidate.role }))
                    .collect();
                let mut stale = failure(
                    ComputerErrorCode::ElementStale,
                    format!(
                        "`{id}` ({} “{}”) is no longer on screen",
                        element.role, element.label
                    ),
                );
                stale.hint = Some("Run `inspect` again and use a fresh element id.".to_string());
                stale.details.insert(
                    "candidates".to_string(),
                    serde_json::Value::Array(candidates),
                );
                Err(stale)
            }
        }
    }

    /// Where to act on the live element, covered or not: the centre of its
    /// visible part (see [`visible_center`]).
    fn center_point(live: &Live) -> ComputerResult<ComputerPoint> {
        let frame = live.element.frame.as_ref().ok_or_else(|| {
            failure(
                ComputerErrorCode::ElementNotFound,
                "the element has no on-screen frame",
            )
        })?;
        visible_center(frame, &clips_of(&live.handle)).ok_or_else(|| {
            let mut hidden = failure(
                ComputerErrorCode::ElementNotFound,
                "the element is scrolled out of view",
            );
            hidden.hint = Some("Scroll it into view, then run inspect again.".to_string());
            hidden
        })
    }

    /// The live element's centre, after checking nothing covers it.
    fn hit_point(live: &Live) -> ComputerResult<ComputerPoint> {
        let center = Self::center_point(live)?;
        #[allow(clippy::cast_possible_truncation)]
        let hit = ffi::element_at(&ffi::system_wide(), center.x as f32, center.y as f32);
        let owner = hit.as_ref().and_then(|hit| ffi::pid(hit));
        if owner.is_some_and(|owner| i64::from(owner) != i64::try_from(live.pid).unwrap_or(-1)) {
            return Err(failure(
                ComputerErrorCode::TargetChanged,
                "something else is covering the element; run inspect again",
            ));
        }
        Ok(center)
    }

    fn point_for(
        &mut self,
        element: Option<&str>,
        x: Option<f64>,
        y: Option<f64>,
    ) -> ComputerResult<(ComputerPoint, Option<Live>)> {
        if let Some(id) = element {
            let live = self.live(id)?;
            let point = Self::hit_point(&live)?;
            return Ok((point, Some(live)));
        }
        match (x, y) {
            (Some(x), Some(y)) => Ok((ComputerPoint { x, y }, None)),
            _ => Err(failure(
                ComputerErrorCode::InvalidPayload,
                "give an element id or both x and y",
            )),
        }
    }

    fn endpoint(&mut self, text: &str) -> ComputerResult<ComputerPoint> {
        if let Some(point) = parse_point(text) {
            return Ok(point);
        }
        let live = self.live(text)?;
        Self::hit_point(&live)
    }

    fn app_for_live(live: &Live) -> ComputerResult<Running> {
        running_app(None, Some(live.pid))
    }
}

fn screen_permission(request: bool) -> ComputerResult<ComputerPermissionState> {
    screen_permission_with(
        request,
        |prompt| {
            if prompt {
                objc2_core_graphics::CGRequestScreenCaptureAccess()
            } else {
                objc2_core_graphics::CGPreflightScreenCaptureAccess()
            }
        },
        || {
            apps::launch(&apps::LaunchSpec {
                bundle_id: Some("com.apple.systempreferences"),
                path: None,
                name: None,
                new_instance: false,
                activate: true,
                documents: vec![
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                ],
            })
        },
    )
}

// Keep native permission decisions testable without resetting the user's grants.
fn screen_permission_with(
    request: bool,
    check: impl FnOnce(bool) -> bool,
    open_settings: impl FnOnce() -> ComputerResult<()>,
) -> ComputerResult<ComputerPermissionState> {
    let granted = check(request);
    // macOS may silently return false once the initial prompt has been
    // answered. An explicit request must still take the user somewhere they
    // can enable the grant; passive checks must never open System Settings.
    if request && !granted {
        open_settings()?;
    }
    Ok(if granted {
        ComputerPermissionState::Granted
    } else {
        ComputerPermissionState::Denied
    })
}

impl ComputerBackend for MacBackend {
    fn permissions(
        &mut self,
        request: &ComputerPermissionsRequest,
    ) -> ComputerResult<ComputerPermissions> {
        let prompt = request.request == Some(true);
        let accessibility = if ffi::is_trusted(
            prompt
                && request
                    .permission
                    .as_ref()
                    .is_none_or(|kind| *kind == ComputerPermissionKind::Accessibility),
        ) {
            ComputerPermissionState::Granted
        } else {
            ComputerPermissionState::Denied
        };
        Ok(ComputerPermissions {
            platform: crate::platform_name().to_string(),
            supported: true,
            accessibility,
            screen_recording: screen_permission(
                prompt
                    && request
                        .permission
                        .as_ref()
                        .is_none_or(|kind| *kind == ComputerPermissionKind::ScreenRecording),
            )?,
        })
    }

    fn displays(&mut self) -> ComputerResult<Vec<ComputerDisplay>> {
        capture::displays()
    }

    fn apps(&mut self, request: &ComputerAppsRequest) -> ComputerResult<Vec<ComputerApp>> {
        let all = if request.installed == Some(true) {
            apps::installed()
        } else {
            apps::running().into_iter().map(|r| r.app).collect()
        };
        let query = request.query.as_deref().unwrap_or_default().to_lowercase();
        Ok(all
            .into_iter()
            .filter(|app| {
                query.is_empty()
                    || app.name.to_lowercase().contains(&query)
                    || app
                        .bundle_id
                        .as_deref()
                        .is_some_and(|id| id.to_lowercase().contains(&query))
            })
            .collect())
    }

    fn windows(&mut self, request: &ComputerWindowsRequest) -> ComputerResult<Vec<ComputerWindow>> {
        let running = apps::running();
        let windows = listed_windows(&running);
        if request.app.is_none() && request.pid.is_none() {
            return Ok(windows);
        }
        let app = running_app(request.app.as_deref(), request.pid)?;
        Ok(windows
            .into_iter()
            .filter(|w| Some(w.pid) == app.app.pid)
            .collect())
    }

    fn open(&mut self, ctx: &Context, request: &ComputerOpenRequest) -> ComputerResult<Focused> {
        let name = request.app.as_deref();
        // Resolve the name against the catalog so `open Safari` launches the
        // bundle, not whatever `open -a` happens to guess.
        let installed = apps::installed();
        let known =
            name.and_then(|name| installed.iter().find(|app| matches_app(app, name)).cloned());
        let bundle_id = known.as_ref().and_then(|app| app.bundle_id.clone());
        let path = known.as_ref().and_then(|app| app.path.clone());
        let documents: Vec<&str> = [request.url.as_deref(), request.file.as_deref()]
            .into_iter()
            .flatten()
            .collect();
        apps::launch(&apps::LaunchSpec {
            bundle_id: bundle_id.as_deref(),
            path: path.as_deref(),
            name,
            new_instance: request.new_instance == Some(true),
            activate: request.activate == Some(true),
            documents,
        })?;
        let wait = Duration::from_millis(
            request
                .wait_ready_ms
                .unwrap_or(CONSTANTS.computer.app_launch_wait_ms.get()),
        );
        let started = Instant::now();
        let lookup = bundle_id.as_deref().or(name);
        loop {
            ctx.stop.check()?;
            if let Ok(app) = running_app(lookup, None) {
                let element = ffi::application(app.handle.processIdentifier());
                ffi::set_timeout(&element, AX_TIMEOUT_SECONDS);
                let ready = app.handle.isFinishedLaunching()
                    && !ffi::elements(&element, "AXWindows").is_empty();
                if ready || started.elapsed() >= wait {
                    let window = app
                        .app
                        .pid
                        .and_then(|pid| ax_window(&element, pid, None).ok())
                        .and_then(|(_, window)| window);
                    return Ok(Focused {
                        app: app.app,
                        window,
                    });
                }
            } else if started.elapsed() >= wait {
                return Err(failure(
                    ComputerErrorCode::Timeout,
                    "the app did not finish launching in time",
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn focus(&mut self, _ctx: &Context, request: &ComputerFocusRequest) -> ComputerResult<Focused> {
        let app = running_app(request.app.as_deref(), request.pid)?;
        let activating = request.activate == Some(true);
        if activating {
            activate(&app)?;
        }
        let pid = app.app.pid.unwrap_or(0);
        let element = ffi::application(pid_i32(pid));
        ffi::set_timeout(&element, AX_TIMEOUT_SECONDS);
        let (window, listed) = ax_window(&element, pid, request.window.as_deref())?;
        if request.window.is_some() {
            // Main within its own app only; raising is the user's call.
            let _ = ffi::set_bool(&window, "AXMain", true);
            if activating {
                let _ = ffi::perform(&window, "AXRaise");
            }
        }
        if !activating {
            focus_for_keys(
                pid_i32(pid),
                request.window.as_deref().and_then(capture::parse_window_id),
            );
        }
        Ok(Focused {
            app: app.app,
            window: listed,
        })
    }

    fn inspect(&mut self, request: &ComputerInspectRequest) -> ComputerResult<ComputerSnapshot> {
        if !ffi::is_trusted(false) {
            return Err(permission_missing("accessibility"));
        }
        let started = Instant::now();
        let app = running_app(request.app.as_deref(), request.pid)?;
        let pid = app.app.pid.unwrap_or(0);
        let element = ffi::application(pid_i32(pid));
        ffi::set_timeout(&element, AX_TIMEOUT_SECONDS);
        let (window, listed) = ax_window(&element, pid, request.window.as_deref())?;
        let seq = self.ring.next_seq();
        let limits = WalkLimits::new(
            request.max_nodes.map(std::num::NonZero::get),
            request.max_depth.map(std::num::NonZero::get),
            request.include_offscreen == Some(true),
        );
        let walked = walk::walk(&window, seq, &limits, &display_rects());
        let query = request.query.as_deref().unwrap_or_default();
        let role = request.role.as_deref();
        let mut elements = Vec::new();
        let mut handles = Vec::new();
        let mut focused = None;
        for (index, (mut element, handle)) in
            walked.elements.into_iter().zip(walked.handles).enumerate()
        {
            if !matches_query(&element, query) || role.is_some_and(|role| role != element.role) {
                continue;
            }
            // Ids stay dense after filtering so `e0..eN` is the whole list.
            let dense = u32::try_from(elements.len()).unwrap_or(u32::MAX);
            element.id = pragma_core::computer::element_id(seq, dense);
            if walked.focused_index == Some(index) {
                focused = Some(element.id.clone());
            }
            elements.push(element);
            handles.push(handle);
        }
        self.ring.insert(
            seq,
            pid,
            listed.as_ref().map(|w| w.id.clone()),
            elements.clone(),
            handles,
        );
        Ok(ComputerSnapshot {
            url: pragma_core::computer_task::observed_url(&elements),
            id: snapshot_id(seq),
            app: app.app,
            window: listed,
            elements,
            focused_element_id: focused,
            truncated: walked.truncated,
            node_count: walked.node_count,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            created_at: now_ms(),
            untrusted: true,
        })
    }

    fn screenshot(
        &mut self,
        ctx: &Context,
        request: &ComputerScreenshotRequest,
        hide_pids: &[u64],
    ) -> ComputerResult<ComputerScreenshot> {
        if !objc2_core_graphics::CGPreflightScreenCaptureAccess() {
            return Err(permission_missing("screenRecording"));
        }
        let target = if let Some(region) = &request.region {
            CaptureTarget::Region(region.clone())
        } else if let Some(display) = &request.display {
            CaptureTarget::Display {
                raw_id: display.rsplit(':').next().and_then(|raw| raw.parse().ok()),
            }
        } else if request.window.is_some() || request.app.is_some() || request.pid.is_some() {
            let running = apps::running();
            let windows = listed_windows(&running);
            let first = if let Some(id) = &request.window {
                windows.into_iter().find(|w| &w.id == id)
            } else {
                let app = running_app(request.app.as_deref(), request.pid)?;
                windows.into_iter().find(|w| Some(w.pid) == app.app.pid)
            }
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::WindowNotFound,
                    "no on-screen window to capture",
                )
            })?;
            CaptureTarget::Window {
                raw_id: capture::parse_window_id(&first.id)
                    .ok_or_else(|| failure(ComputerErrorCode::WindowNotFound, "bad window id"))?,
                frame: first.frame,
            }
        } else {
            CaptureTarget::Display { raw_id: None }
        };
        capture::capture(
            &target,
            &CaptureOutput {
                format: request.format.unwrap_or(ComputerImageFormat::Png),
                max_width: request.max_width.and_then(|w| u32::try_from(w.get()).ok()),
                path: request.out.as_ref().map(std::path::PathBuf::from),
                directory: ctx.screenshots_dir.clone(),
                inline: request.base64 == Some(true),
            },
            hide_pids,
        )
    }

    fn resolve(&mut self, request: &ResolveRequest) -> ComputerResult<Resolved> {
        if let Some(id) = &request.element {
            let live = self.live(id)?;
            let app = Self::app_for_live(&live)?;
            let point = Self::center_point(&live).ok();
            let (window, covered) = point.as_ref().map_or((None, false), |point| {
                pointer_window(live.pid, point, live.window)
            });
            return Ok(Resolved {
                app: app.app,
                window,
                element: Some(live.element),
                point,
                covered,
            });
        }
        let app = if request.app.is_none() && request.pid.is_none() {
            // A bare point resolves to whoever owns it.
            let owner = request.point.as_ref().and_then(|point| {
                #[allow(clippy::cast_possible_truncation)]
                let hit = ffi::element_at(&ffi::system_wide(), point.x as f32, point.y as f32)?;
                ffi::pid(&hit)
            });
            running_app(None, owner.and_then(|pid| u64::try_from(pid).ok()))?
        } else {
            running_app(request.app.as_deref(), request.pid)?
        };
        let (window, covered) = match (&request.point, app.app.pid) {
            (Some(point), Some(pid)) => pointer_window(pid, point, None),
            _ => (None, false),
        };
        Ok(Resolved {
            app: app.app,
            window,
            element: None,
            point: request.point.clone(),
            covered,
        })
    }

    fn click(
        &mut self,
        ctx: &Context,
        request: &ComputerClickRequest,
    ) -> ComputerResult<Performed> {
        let button = request.button.unwrap_or(ComputerMouseButton::Left);
        let count = u32::try_from(request.count.map_or(1, std::num::NonZero::get)).unwrap_or(1);
        let method = request.method.unwrap_or(ComputerMethod::Auto);
        let held = modifiers(&request.modifiers)?;
        if let Some(id) = &request.element {
            let live = self.live(id)?;
            let pressable = live.element.actions.iter().any(|action| action == "press");
            if method != ComputerMethod::Pointer
                && pressable
                && button == ComputerMouseButton::Left
                && count == 1
                && held.is_empty()
            {
                ctx.stop.check()?;
                match ffi::perform(&live.handle, "AXPress") {
                    Ok(()) => {
                        return Ok(Performed {
                            method: ComputerMethod::Ax,
                            physical_cursor: false,
                            element: Some(live.element),
                        })
                    }
                    Err(_) if method == ComputerMethod::Ax => {
                        return Err(failure(
                            ComputerErrorCode::Internal,
                            "the app refused AXPress",
                        ));
                    }
                    Err(_) => {}
                }
            } else if method == ComputerMethod::Ax {
                return Err(failure(
                    ComputerErrorCode::InvalidPayload,
                    "that element has no press action",
                ));
            }
            // In the background the event is addressed to the element's
            // window, so another app covering it does not matter.
            if let Ok(center) = Self::center_point(&live) {
                if background_click(ctx, live.pid, &center, live.window, (button, count, &held))? {
                    return Ok(Performed {
                        method: ComputerMethod::Pointer,
                        physical_cursor: false,
                        element: Some(live.element),
                    });
                }
            }
            let app = Self::app_for_live(&live)?;
            let point = Self::hit_point(&live)?;
            pointer_click(ctx, &app, &point, button, count, &held)?;
            return Ok(Performed {
                method: ComputerMethod::Pointer,
                physical_cursor: true,
                element: Some(live.element),
            });
        }
        let (point, _) = self.point_for(None, request.x, request.y)?;
        let app = self.resolve(&ResolveRequest {
            app: request.app.clone(),
            pid: request.pid,
            point: Some(point.clone()),
            ..ResolveRequest::default()
        })?;
        let pid = app.app.pid.unwrap_or(0);
        if background_click(ctx, pid, &point, None, (button, count, &held))? {
            return Ok(Performed {
                method: ComputerMethod::Pointer,
                physical_cursor: false,
                element: None,
            });
        }
        let running = running_app(None, Some(pid))?;
        pointer_click(ctx, &running, &point, button, count, &held)?;
        Ok(Performed {
            method: ComputerMethod::Pointer,
            physical_cursor: true,
            element: None,
        })
    }

    fn type_text(
        &mut self,
        ctx: &Context,
        request: &ComputerTypeRequest,
    ) -> ComputerResult<Performed> {
        let method = request.method.unwrap_or(ComputerMethod::Auto);
        let replace = request.replace == Some(true);
        let (app, own, element) = if let Some(id) = &request.element {
            let live = self.live(id)?;
            if live.element.secure && request.secret != Some(true) {
                return Err(failure(
                    ComputerErrorCode::ApprovalRequired,
                    "typing into a secure field needs --secret",
                ));
            }
            ctx.stop.check()?;
            // Setting the value directly needs no focus and no keystrokes.
            if method != ComputerMethod::Keys
                && replace
                && live.element.editable
                && !live.element.secure
                && ffi::set_string(&live.handle, "AXValue", &request.text).is_ok()
            {
                {
                    if request.submit == Some(true) {
                        send_chord(pid_i32(live.pid), &chord("enter")?)?;
                    }
                    return Ok(Performed {
                        method: ComputerMethod::Ax,
                        physical_cursor: false,
                        element: Some(live.element),
                    });
                }
            }
            // Keys go to the app's focused element, which Accessibility can
            // move without activating the app.
            let _ = ffi::set_bool(&live.handle, "AXFocused", true);
            (Self::app_for_live(&live)?, live.window, Some(live.element))
        } else {
            (
                running_app(request.app.as_deref(), request.pid)?,
                None,
                None,
            )
        };
        if method == ComputerMethod::Ax {
            return Err(failure(
                ComputerErrorCode::InvalidPayload,
                "that field cannot be set directly; use --method keys",
            ));
        }
        let pid = app.handle.processIdentifier();
        focus_for_keys(pid, own);
        if replace {
            send_chord(pid, &chord("cmd+a")?)?;
        }
        background::type_text(&ctx.stop, pid, &request.text)?;
        if request.submit == Some(true) {
            ctx.stop.check()?;
            send_chord(pid, &chord("enter")?)?;
        }
        Ok(Performed {
            method: ComputerMethod::Keys,
            physical_cursor: false,
            element,
        })
    }

    fn key(&mut self, ctx: &Context, request: &ComputerKeyRequest) -> ComputerResult<Performed> {
        let chords = request
            .chords
            .iter()
            .map(|chord| parse_chord(chord, ChordPlatform::Mac).map_err(invalid))
            .collect::<ComputerResult<Vec<_>>>()?;
        if chords.is_empty() {
            return Err(failure(
                ComputerErrorCode::InvalidPayload,
                "give at least one chord",
            ));
        }
        // Posted to the app itself, so it is never activated and no other app
        // can receive the keys.
        let pid = running_app(request.app.as_deref(), request.pid)?
            .handle
            .processIdentifier();
        focus_for_keys(pid, None);
        let repeat = request.repeat.map_or(1, std::num::NonZero::get);
        for _ in 0..repeat {
            for chord in &chords {
                ctx.stop.check()?;
                send_chord(pid, chord)?;
            }
        }
        Ok(Performed {
            method: ComputerMethod::Keys,
            physical_cursor: false,
            element: None,
        })
    }

    fn scroll(
        &mut self,
        ctx: &Context,
        request: &ComputerScrollRequest,
    ) -> ComputerResult<Performed> {
        let (point, live) = match (&request.element, request.x, request.y) {
            (None, None, None) => {
                // No target: scroll the middle of the app's front window.
                let app = running_app(request.app.as_deref(), request.pid)?;
                let pid = app.app.pid.unwrap_or(0);
                let element = ffi::application(pid_i32(pid));
                let (window, _) = ax_window(&element, pid, None)?;
                let frame = live_frame(&window).ok_or_else(|| {
                    failure(ComputerErrorCode::WindowNotFound, "the window has no frame")
                })?;
                (rect_center(&frame), None)
            }
            // Background scrolling is addressed to the element's own window,
            // so another app covering it does not matter; the foreground
            // fallback below checks coverage before it moves the pointer.
            (Some(id), _, _) => {
                let live = self.live(id)?;
                (Self::center_point(&live)?, Some(live))
            }
            (None, x, y) => self.point_for(None, x, y)?,
        };
        let owner = match (&live, &request.app, request.pid) {
            (Some(live), _, _) => Some(live.pid),
            (None, None, None) => {
                window_owner_at(&to_cg(&point)).and_then(|pid| u64::try_from(pid).ok())
            }
            (None, app, pid) => running_app(app.as_deref(), pid)?.app.pid,
        };
        let amount = i32::try_from(request.amount.map_or(3, std::num::NonZero::get)).unwrap_or(3);
        let (vertical, horizontal) = match request.direction {
            ComputerScrollDirection::Up => (amount, 0),
            ComputerScrollDirection::Down => (-amount, 0),
            ComputerScrollDirection::Left => (0, amount),
            ComputerScrollDirection::Right => (0, -amount),
        };
        let own = live.as_ref().and_then(|live| live.window);
        if let Some(target) = owner.and_then(|pid| background_target(pid, &point, own)) {
            background::scroll(&ctx.stop, &target, vertical, horizontal)?;
            return Ok(Performed {
                method: ComputerMethod::Pointer,
                physical_cursor: false,
                element: live.map(|live| live.element),
            });
        }
        // Wheel events go to the window under the pointer whether or not its
        // app is active, so even this path brings nothing to the front, but
        // they would land in whatever covers the element.
        if let Some(live) = &live {
            Self::hit_point(live)?;
        }
        input::move_to(to_cg(&point))?;
        input::scroll(&ctx.stop, vertical, horizontal)?;
        Ok(Performed {
            method: ComputerMethod::Pointer,
            physical_cursor: true,
            element: live.map(|live| live.element),
        })
    }

    fn move_pointer(
        &mut self,
        _ctx: &Context,
        request: &ComputerMoveRequest,
    ) -> ComputerResult<Performed> {
        let (point, live) = self.point_for(request.element.as_deref(), request.x, request.y)?;
        let visual_only = request.visual_only == Some(true);
        if !visual_only {
            input::move_to(to_cg(&point))?;
        }
        Ok(Performed {
            method: ComputerMethod::Pointer,
            physical_cursor: !visual_only,
            element: live.map(|live| live.element),
        })
    }

    fn drag(&mut self, ctx: &Context, request: &ComputerDragRequest) -> ComputerResult<Performed> {
        let from = self.endpoint(&request.from)?;
        let to = self.endpoint(&request.to)?;
        let owner = self.resolve(&ResolveRequest {
            app: request.app.clone(),
            pid: request.pid,
            point: Some(from.clone()),
            ..ResolveRequest::default()
        })?;
        let app = running_app(None, owner.app.pid)?;
        require_frontmost(&app)?;
        let held = modifiers(&request.modifiers)?;
        let duration = Duration::from_millis(request.duration_ms.unwrap_or(300));
        input::drag(&ctx.stop, to_cg(&from), to_cg(&to), duration, &held)?;
        Ok(Performed {
            method: ComputerMethod::Pointer,
            physical_cursor: true,
            element: None,
        })
    }

    fn user_activity(&mut self, pid: Option<u64>) -> Option<UserActivity> {
        Some(user_activity(pid))
    }
}

fn pointer_click(
    ctx: &Context,
    app: &Running,
    point: &ComputerPoint,
    button: ComputerMouseButton,
    count: u32,
    held: &[Modifier],
) -> ComputerResult<()> {
    require_frontmost(app)?;
    let restore = (count == 1).then(input::pointer_location).flatten();
    input::click(&ctx.stop, to_cg(point), button, count, held)?;
    // A single click puts the cursor back where the user left it.
    if let Some(restore) = restore {
        let _ = input::move_to(restore);
    }
    Ok(())
}

/// Gives `pid`'s front window keyboard focus without raising it, the same
/// focus record a background click sends first.
///
/// Keys posted to an app (and the menu items shortcuts press) go to its key
/// window. A background app loses that the moment the user works in another
/// app, so without this a key or shortcut "succeeds" and does nothing.
/// Best-effort: a frontmost app needs nothing, and when the record is refused
/// the keys are still sent, as before.
///
/// The window is `own` (an element's window) when given, else the one the app
/// itself calls focused or main. The app's frontmost window in the Window
/// Server list is only a last resort: it can be a panel or an invisible
/// helper window, and keys focused there vanish while reporting success.
fn focus_for_keys(pid: i32, own: Option<u32>) {
    if frontmost_pid() == Some(pid) || !background::available() {
        return;
    }
    let app = ffi::application(pid);
    ffi::set_timeout(&app, AX_TIMEOUT_SECONDS);
    let Ok(ax_pid) = u64::try_from(pid) else {
        return;
    };
    let own = match own {
        // Keys sent to an app go to its main window, and the focus record
        // does not change which of the app's windows that is: make the
        // element's window main first (this does not activate the app).
        Some(own) => {
            if let Ok((window, _)) = ax_window(&app, ax_pid, Some(&capture::window_id(own))) {
                let _ = ffi::set_bool(&window, "AXMain", true);
            }
            Some(own)
        }
        None => ax_window(&app, ax_pid, None)
            .ok()
            .and_then(|(_, listed)| listed)
            .and_then(|window| capture::parse_window_id(&window.id)),
    };
    let Some(window) = ffi::window_list().into_iter().find(|info| {
        info.pid == pid
            && info.layer == 0
            && info.w > 1.0
            && info.h > 1.0
            && own.is_none_or(|own| info.id == own)
    }) else {
        background::trace(|| format!("keys: no window to focus for pid {pid}"));
        return;
    };
    let target = background::Target {
        pid,
        window: window.id,
        point: CGPoint {
            x: window.x + window.w / 2.0,
            y: window.y + window.h / 2.0,
        },
        origin: CGPoint {
            x: window.x,
            y: window.y,
        },
        height: window.h,
    };
    if let Err(error) = background::prepare(&target) {
        background::trace(|| format!("keys: focus record refused: {}", error.message));
    }
}

/// Sends one chord to `pid` in the background: a menu shortcut by pressing
/// its menu item, anything else as keys.
fn send_chord(pid: i32, chord: &Chord) -> ComputerResult<()> {
    if press_menu_shortcut(pid, chord) {
        return Ok(());
    }
    background::press(pid, chord)
}

/// Presses the enabled menu item whose shortcut is `chord` through
/// Accessibility. `AppKit` only runs menu key equivalents for the active app,
/// so a shortcut posted to a background app would be dropped; pressing the
/// item runs the same command without activating anything.
fn press_menu_shortcut(pid: i32, chord: &Chord) -> bool {
    /// Bounds the walk of an app's menus (menu bar, menus, one submenu level).
    const MAX_ITEMS: usize = 4000;
    const MAX_DEPTH: u8 = 5;
    let (Some(mask), Key::Char(character)) = (ax_menu_modifiers(chord), chord.key) else {
        return false;
    };
    let app = ffi::application(pid);
    ffi::set_timeout(&app, AX_TIMEOUT_SECONDS);
    let Some(bar) = ffi::element(&app, "AXMenuBar") else {
        background::trace(|| format!("menu: no AXMenuBar for pid {pid}"));
        return false;
    };
    let shift = chord.modifiers.contains(&Modifier::Shift);
    let matches = |item: &Element| {
        let Some(shortcut) = ffi::string(item, "AXMenuItemCmdChar") else {
            return false;
        };
        let mut chars = shortcut.chars();
        let (Some(only), None) = (chars.next(), chars.next()) else {
            return false;
        };
        if !only.eq_ignore_ascii_case(&character) {
            return false;
        }
        let item_mask = ffi::integer(item, "AXMenuItemCmdModifiers").unwrap_or(0);
        // AppKit spells Shift either as the mask bit or as an uppercase key.
        item_mask == mask || (shift && only.is_uppercase() && item_mask == mask & !1)
    };
    let mut stack: Vec<(Element, u8)> = ffi::elements(&bar, "AXChildren")
        .into_iter()
        .map(|item| (item, 0))
        .collect();
    let mut seen = 0;
    while let Some((node, depth)) = stack.pop() {
        seen += 1;
        if seen > MAX_ITEMS {
            break;
        }
        if matches(&node) {
            let enabled = ffi::boolean(&node, "AXEnabled");
            let pressed = enabled != Some(false) && ffi::perform(&node, "AXPress").is_ok();
            background::trace(|| {
                format!(
                    "menu {:?} enabled={enabled:?} pressed={pressed}",
                    ffi::string(&node, "AXTitle")
                )
            });
            return pressed;
        }
        if depth < MAX_DEPTH {
            stack.extend(
                ffi::elements(&node, "AXChildren")
                    .into_iter()
                    .map(|child| (child, depth + 1)),
            );
        }
    }
    background::trace(|| format!("menu: no item for {chord:?} (mask {mask}) after {seen} nodes"));
    false
}

fn chord(text: &str) -> ComputerResult<Chord> {
    parse_chord(text, ChordPlatform::Mac).map_err(invalid)
}

fn invalid(message: String) -> pragma_constants::ComputerFailure {
    failure(ComputerErrorCode::InvalidPayload, message)
}

fn permission_missing(permission: &str) -> pragma_constants::ComputerFailure {
    let mut missing = failure(
        ComputerErrorCode::PermissionMissing,
        format!("the computer-use helper does not have the {permission} permission"),
    );
    missing.hint = Some("Run `pragma-cli computer permissions --request`, then allow it in System Settings → Privacy & Security.".to_string());
    missing.details.insert(
        "permission".to_string(),
        serde_json::Value::String(permission.to_string()),
    );
    missing
}

/// Physical input probe shared with native action cancellation.
pub(super) fn user_activity(pid: Option<u64>) -> UserActivity {
    // An unknown target is treated as the one the user is on.
    let (target_frontmost, pointer_over_target) = match pid.map(pid_i32) {
        Some(pid) => (
            frontmost_pid() == Some(pid),
            input::pointer_location().and_then(|point| window_owner_at(&point)) == Some(pid),
        ),
        None => (true, true),
    };
    UserActivity {
        keyboard_seconds: user_seconds(
            input::seconds_since_key_press(),
            background::seconds_since_own_key(),
        ),
        pointer_seconds: user_seconds(
            input::seconds_since_pointer_use(),
            background::seconds_since_own_pointer(),
        ),
        target_frontmost,
        pointer_over_target,
    }
}

#[cfg(test)]
mod screen_permission_tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn a_silently_denied_request_opens_settings_after_requesting_the_grant() {
        let calls = RefCell::new(Vec::new());
        let state = screen_permission_with(
            true,
            |prompt| {
                assert!(prompt);
                calls.borrow_mut().push("request");
                false
            },
            || {
                calls.borrow_mut().push("open settings");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(state, ComputerPermissionState::Denied);
        assert_eq!(*calls.borrow(), ["request", "open settings"]);
    }

    #[test]
    fn passive_checks_and_granted_requests_do_not_open_settings() {
        for (request, granted) in [(false, false), (false, true), (true, true)] {
            let state = screen_permission_with(
                request,
                |prompt| {
                    assert_eq!(prompt, request);
                    granted
                },
                || panic!("must not open settings for a passive check or an existing grant"),
            )
            .unwrap();
            assert_eq!(
                state,
                if granted {
                    ComputerPermissionState::Granted
                } else {
                    ComputerPermissionState::Denied
                }
            );
        }
    }

    #[test]
    fn a_failed_settings_launch_is_reported_to_the_button() {
        let error = screen_permission_with(
            true,
            |_| false,
            || {
                Err(failure(
                    ComputerErrorCode::AppNotFound,
                    "System Settings unavailable",
                ))
            },
        )
        .unwrap_err();
        assert_eq!(error.message, "System Settings unavailable");
    }
}
