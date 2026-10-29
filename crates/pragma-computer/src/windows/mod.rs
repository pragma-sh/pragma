//! Windows backend: cached UI Automation, Unicode `SendInput`, and window capture.
mod ffi;
mod input;
use crate::capture::{self, CaptureOutput, CaptureTarget};
use crate::snapshot::{self, SnapshotRing, WalkLimits};
use crate::{
    failure, ComputerBackend, ComputerResult, Context, Focused, Performed, ResolveRequest,
    Resolved, UserActivity,
};
use pragma_constants::{
    ComputerApp, ComputerAppsRequest, ComputerClickRequest, ComputerDisplay, ComputerDragRequest,
    ComputerElement, ComputerErrorCode, ComputerFocusRequest, ComputerImageFormat,
    ComputerInspectRequest, ComputerKeyRequest, ComputerMethod, ComputerMouseButton,
    ComputerMoveRequest, ComputerOpenRequest, ComputerPermissionState, ComputerPermissions,
    ComputerPermissionsRequest, ComputerPoint, ComputerRect, ComputerScreenshot,
    ComputerScreenshotRequest, ComputerScrollDirection, ComputerScrollRequest, ComputerSnapshot,
    ComputerTypeRequest, ComputerWindow, ComputerWindowsRequest, CONSTANTS,
};
use pragma_core::computer::{
    matches_query, parse_point, rect_center, rect_contains, revalidate, snapshot_id, Revalidation,
};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

pub struct WindowsBackend {
    api: ComputerResult<ffi::Automation>,
    ring: SnapshotRing<ffi::Element>,
}
impl WindowsBackend {
    pub fn new() -> Self {
        // Hook now, so input the user makes before the first probe is seen.
        ffi::watch_physical_input();
        Self {
            api: ffi::Automation::new(),
            ring: SnapshotRing::default(),
        }
    }
    fn api(&self) -> ComputerResult<&ffi::Automation> {
        self.api.as_ref().map_err(Clone::clone)
    }
    fn listed_windows() -> ComputerResult<Vec<ComputerWindow>> {
        xcap::Window::all()
            .map_err(|_| failure(ComputerErrorCode::Internal, "Could not list windows"))?
            .into_iter()
            .map(|window| {
                let pid = window
                    .pid()
                    .map_err(|_| failure(ComputerErrorCode::WindowNotFound, "Window closed"))?;
                let app = app_for(pid, window.app_name().unwrap_or_default());
                Ok(ComputerWindow {
                    id: capture::window_id(window.id().unwrap_or_default()),
                    app_id: app.id,
                    app_name: app.name,
                    pid: u64::from(pid),
                    title: window.title().unwrap_or_default(),
                    frame: ComputerRect {
                        x: f64::from(window.x().unwrap_or_default()),
                        y: f64::from(window.y().unwrap_or_default()),
                        w: f64::from(window.width().unwrap_or_default()),
                        h: f64::from(window.height().unwrap_or_default()),
                        display_id: None,
                    },
                    focused: window.is_focused().unwrap_or(false),
                    minimized: window.is_minimized().unwrap_or(false),
                    on_screen: !window.is_minimized().unwrap_or(false),
                })
            })
            .collect()
    }
    fn select(
        app: Option<&str>,
        pid: Option<u64>,
        window: Option<&str>,
    ) -> ComputerResult<(ComputerApp, ComputerWindow)> {
        let windows = Self::listed_windows()?;
        let selected = windows
            .into_iter()
            .find(|w| {
                if let Some(id) = window {
                    return w.id == id;
                }
                if let Some(pid) = pid {
                    return w.pid == pid;
                }
                if let Some(name) = app {
                    return matches_app(
                        &app_for(u32::try_from(w.pid).unwrap_or_default(), w.app_name.clone()),
                        name,
                    );
                }
                w.focused
            })
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::WindowNotFound,
                    "No matching application window; open it first",
                )
            })?;
        let app = app_for(
            u32::try_from(selected.pid).unwrap_or_default(),
            selected.app_name.clone(),
        );
        Ok((app, selected))
    }
    fn element(
        &mut self,
        id: &str,
    ) -> ComputerResult<(ComputerApp, ComputerWindow, ComputerElement, ffi::Element)> {
        let (stored, index) = self.ring.lookup(id)?;
        let element = stored.elements[index].clone();
        let pid = stored.pid;
        let window = stored.window_id.clone();
        let request: ComputerInspectRequest =
            serde_json::from_value(serde_json::json!({"pid":pid,"window":window}))
                .map_err(|_| failure(ComputerErrorCode::Internal, "Invalid stored window"))?;
        let fresh = self.inspect(&request)?;
        let index = match revalidate(&element, &fresh.elements) {
            Revalidation::SamePath(i) | Revalidation::Moved(i) => i,
            Revalidation::Stale(_) => {
                return Err(failure(
                    ComputerErrorCode::ElementStale,
                    "The element changed; inspect again",
                ))
            }
        };
        let (stored, fresh_index) = self.ring.lookup(&fresh.elements[index].id)?;
        let handle = stored.handles[fresh_index].clone();
        Ok((
            fresh.app,
            fresh
                .window
                .ok_or_else(|| failure(ComputerErrorCode::WindowNotFound, "Window closed"))?,
            fresh.elements[index].clone(),
            handle,
        ))
    }
    fn input_target(
        app: Option<&str>,
        pid: Option<u64>,
    ) -> ComputerResult<(ComputerApp, ComputerWindow)> {
        let (app, window) = Self::select(app, pid, None)?;
        ffi::refuse_elevated(u32::try_from(window.pid).unwrap_or_default())?;
        refuse_minimized(&window)?;
        if ffi::foreground_pid() != Some(window.pid) {
            ffi::activate(
                capture::parse_window_id(&window.id).ok_or_else(|| {
                    failure(ComputerErrorCode::WindowNotFound, "Invalid window id")
                })?,
            )?;
        }
        if ffi::foreground_pid() != Some(window.pid) {
            return Err(failure(
                ComputerErrorCode::TargetChanged,
                "Target did not become foreground",
            ));
        }
        Ok((app, window))
    }
    /// A pointer target, with activation attempted but not required.
    ///
    /// Windows routes mouse input by the window under the cursor, so a refused
    /// foreground change must not fail a click: clicking the window is itself
    /// what brings it forward. Keyboard input still uses [`Self::input_target`].
    /// The boolean reports whether the target really is foreground, so a caller
    /// that needs modifiers (which are keyboard events) can refuse.
    fn pointer_window(
        app: Option<&str>,
        pid: Option<u64>,
    ) -> ComputerResult<(ComputerApp, ComputerWindow, bool)> {
        let (app, window) = Self::select(app, pid, None)?;
        ffi::refuse_elevated(u32::try_from(window.pid).unwrap_or_default())?;
        refuse_minimized(&window)?;
        let mut foreground = ffi::foreground_pid() == Some(window.pid);
        if !foreground {
            if let Some(id) = capture::parse_window_id(&window.id) {
                let _ = ffi::activate(id);
            }
            foreground = ffi::foreground_pid() == Some(window.pid);
        }
        Ok((app, window, foreground))
    }
    fn pointer_target(&mut self, request: &ResolveRequest) -> ComputerResult<Resolved> {
        self.resolve(request)
    }
}
fn app_for(pid: u32, name: String) -> ComputerApp {
    let path = ffi::process_path(pid);
    let aumid = ffi::process_aumid(pid);
    let id = format!(
        "app:win:{}",
        aumid
            .as_deref()
            .or(path.as_deref())
            .unwrap_or(&name)
            .to_lowercase()
    );
    ComputerApp {
        id,
        name,
        bundle_id: aumid,
        path,
        pid: Some(u64::from(pid)),
        running: true,
        frontmost: ffi::foreground_pid() == Some(u64::from(pid)),
        hidden: None,
        blocked: None,
    }
}
fn matches_app(app: &ComputerApp, name: &str) -> bool {
    app.id.eq_ignore_ascii_case(name)
        || app.name.eq_ignore_ascii_case(name)
        || app.path.as_ref().is_some_and(|p| {
            let path = std::path::Path::new(p);
            p.eq_ignore_ascii_case(name)
                || path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(name))
                // Agents and the CLI say "notepad", not "Notepad.exe"; matching
                // the stem is what lets `open` reuse a running window instead of
                // launching another one (and then timing out on the app catalog).
                || path
                    .file_stem()
                    .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(name))
        })
}
fn performed(
    method: ComputerMethod,
    physical: bool,
    element: Option<ComputerElement>,
) -> Performed {
    Performed {
        method,
        physical_cursor: physical,
        element,
    }
}
fn resolve_request(
    app: Option<String>,
    pid: Option<u64>,
    element: Option<String>,
    point: Option<ComputerPoint>,
) -> ResolveRequest {
    ResolveRequest {
        app,
        pid,
        element,
        point,
        window: None,
    }
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |t| u64::try_from(t.as_millis()).unwrap_or(u64::MAX))
}

impl ComputerBackend for WindowsBackend {
    fn permissions(
        &mut self,
        _: &ComputerPermissionsRequest,
    ) -> ComputerResult<ComputerPermissions> {
        self.api()?;
        Ok(ComputerPermissions {
            platform: "windows".to_string(),
            supported: true,
            accessibility: ComputerPermissionState::NotApplicable,
            screen_recording: ComputerPermissionState::NotApplicable,
        })
    }
    fn displays(&mut self) -> ComputerResult<Vec<ComputerDisplay>> {
        capture::displays()
    }
    fn apps(&mut self, request: &ComputerAppsRequest) -> ComputerResult<Vec<ComputerApp>> {
        let mut apps: BTreeMap<String, ComputerApp> = Self::listed_windows()?
            .into_iter()
            .map(|w| {
                let app = app_for(u32::try_from(w.pid).unwrap_or_default(), w.app_name);
                (app.id.clone(), app)
            })
            .collect();
        if request.installed == Some(true) {
            // This fixed OS command enumerates AppsFolder registrations, including Store AUMIDs.
            // No caller-controlled string is interpolated into a shell program.
            let output = pragma_platform::process::command("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
                ])
                .output()
                .map_err(|_| {
                    failure(
                        ComputerErrorCode::Internal,
                        "Could not enumerate installed applications",
                    )
                })?;
            if !output.status.success() {
                return Err(failure(
                    ComputerErrorCode::Internal,
                    "Windows application catalog failed",
                ));
            }
            let entries: serde_json::Value = serde_json::from_slice(&output.stdout)
                .map_err(|_| failure(ComputerErrorCode::Internal, "Invalid application catalog"))?;
            let list = entries.as_array().cloned().unwrap_or_else(|| vec![entries]);
            for entry in list {
                if let (Some(name), Some(aumid)) = (entry["Name"].as_str(), entry["AppID"].as_str())
                {
                    let id = format!("app:win:{aumid}");
                    apps.entry(id.clone()).or_insert(ComputerApp {
                        id,
                        name: name.to_string(),
                        bundle_id: Some(aumid.to_string()),
                        path: None,
                        pid: None,
                        running: false,
                        frontmost: false,
                        hidden: None,
                        blocked: None,
                    });
                }
            }
        }
        Ok(apps
            .into_values()
            .filter(|a| {
                request.query.as_ref().is_none_or(|q| {
                    a.name.to_lowercase().contains(&q.to_lowercase())
                        || a.id.to_lowercase().contains(&q.to_lowercase())
                })
            })
            .collect())
    }
    fn windows(&mut self, request: &ComputerWindowsRequest) -> ComputerResult<Vec<ComputerWindow>> {
        Ok(Self::listed_windows()?
            .into_iter()
            .filter(|w| {
                request.pid.is_none_or(|pid| w.pid == pid)
                    && request.app.as_ref().is_none_or(|name| {
                        matches_app(
                            &app_for(u32::try_from(w.pid).unwrap_or_default(), w.app_name.clone()),
                            name,
                        )
                    })
            })
            .collect())
    }
    fn open(&mut self, ctx: &Context, request: &ComputerOpenRequest) -> ComputerResult<Focused> {
        ctx.stop.check()?;
        if request.url.is_none() && request.file.is_none() && request.new_instance != Some(true) {
            if let Ok((app, window)) = Self::select(request.app.as_deref(), request.pid, None) {
                if request.activate == Some(true) {
                    Self::input_target(request.app.as_deref(), request.pid)?;
                }
                return Ok(Focused {
                    app,
                    window: Some(window),
                });
            }
        }
        let name = request.app.as_deref().ok_or_else(|| {
            failure(
                ComputerErrorCode::InvalidPayload,
                "Name the application to open",
            )
        })?;
        let bare = name.strip_prefix("app:win:").unwrap_or(name);
        let registered = self
            .apps(&ComputerAppsRequest {
                installed: Some(true),
                query: None,
            })
            .unwrap_or_default()
            .into_iter()
            .find(|a| {
                a.bundle_id.is_some()
                    && (a.name.eq_ignore_ascii_case(name)
                        || a.id.eq_ignore_ascii_case(name)
                        || a.bundle_id
                            .as_ref()
                            .is_some_and(|id| id.eq_ignore_ascii_case(bare)))
            });
        let query = registered.as_ref().map_or(name, |a| a.name.as_str());
        let registration = registered.as_ref().and_then(|a| a.bundle_id.as_deref());
        let app = if let Some(id) = registration {
            format!("shell:AppsFolder\\{id}")
        } else if bare.contains('!') {
            format!("shell:AppsFolder\\{bare}")
        } else {
            bare.to_string()
        };
        if request
            .url
            .as_ref()
            .or(request.file.as_ref())
            .is_some_and(|s| s.contains('"') || s.contains('\0'))
        {
            return Err(failure(
                ComputerErrorCode::InvalidPayload,
                "Invalid launch argument",
            ));
        }
        let argument = request
            .url
            .as_ref()
            .or(request.file.as_ref())
            .map(|s| format!("\"{s}\""));
        ffi::launch(&app, argument.as_deref())?;
        let start = Instant::now();
        let wait = request
            .wait_ready_ms
            .unwrap_or(CONSTANTS.computer.app_launch_wait_ms.get());
        loop {
            ctx.stop.check()?;
            if let Ok((app, window)) = Self::select(Some(query), request.pid, None) {
                return Ok(Focused {
                    app,
                    window: Some(window),
                });
            }
            if start.elapsed() >= Duration::from_millis(wait) {
                return Err(failure(
                    ComputerErrorCode::Timeout,
                    "Application did not create a window",
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    fn focus(&mut self, ctx: &Context, request: &ComputerFocusRequest) -> ComputerResult<Focused> {
        ctx.stop.check()?;
        let (app, window) = Self::select(
            request.app.as_deref(),
            request.pid,
            request.window.as_deref(),
        )?;
        ffi::refuse_elevated(u32::try_from(window.pid).unwrap_or_default())?;
        if request.activate == Some(true) {
            ffi::activate(
                capture::parse_window_id(&window.id).ok_or_else(|| {
                    failure(ComputerErrorCode::WindowNotFound, "Invalid window id")
                })?,
            )?;
        }
        Ok(Focused {
            app,
            window: Some(window),
        })
    }
    fn inspect(&mut self, request: &ComputerInspectRequest) -> ComputerResult<ComputerSnapshot> {
        let (app, window) = Self::select(
            request.app.as_deref(),
            request.pid,
            request.window.as_deref(),
        )?;
        refuse_minimized(&window)?;
        ffi::refuse_elevated(u32::try_from(window.pid).unwrap_or_default())?;
        let limits = walk_limits(request);
        let seq = self.ring.next_seq();
        let start = Instant::now();
        let api = self.api()?;
        let root = api
            .root(capture::parse_window_id(&window.id).ok_or_else(|| {
                failure(ComputerErrorCode::WindowNotFound, "Invalid window id")
            })?)?;
        let mut stack = vec![(root, vec![], vec![])];
        let mut elements = vec![];
        let mut handles = vec![];
        let mut nodes = 0;
        let mut truncated = false;
        let mut focused = None;
        while let Some((handle, path, ancestors)) = stack.pop() {
            if walk_exhausted(nodes, &limits, start) {
                truncated = true;
                break;
            }
            nodes += 1;
            let Ok(node) = api.node(&handle, path.clone(), ancestors.clone()) else {
                continue;
            };
            let on_screen = !node.offscreen
                && node
                    .frame
                    .as_ref()
                    .is_some_and(|frame| frame.w > 0.0 && frame.h > 0.0);
            let label = snapshot::label_of(&node);
            if !path.is_empty()
                && snapshot::is_interesting(&node, &label)
                && (on_screen || limits.include_offscreen)
            {
                let element = snapshot::to_element(
                    seq,
                    u32::try_from(elements.len()).unwrap_or(u32::MAX),
                    &node,
                    label,
                    on_screen,
                );
                if request
                    .query
                    .as_ref()
                    .is_none_or(|q| matches_query(&element, q))
                    && request
                        .role
                        .as_ref()
                        .is_none_or(|r| element.role.eq_ignore_ascii_case(r))
                {
                    if element.focused {
                        focused = Some(element.id.clone());
                    }
                    elements.push(element);
                    handles.push(handle.clone());
                }
            }
            if path.len() < limits.max_depth
                && (on_screen || limits.include_offscreen || path.is_empty())
            {
                let mut ancestors = ancestors;
                ancestors.push(node.role);
                let children = api.children(&handle, limits.max_nodes.saturating_sub(nodes));
                for (index, child) in children.into_iter().enumerate().rev() {
                    let mut path = path.clone();
                    path.push(index as u64);
                    stack.push((child, path, ancestors.clone()));
                }
            }
        }
        self.ring.insert(
            seq,
            window.pid,
            Some(window.id.clone()),
            elements.clone(),
            handles,
        );
        Ok(ComputerSnapshot {
            url: pragma_core::computer_task::observed_url(&elements),
            id: snapshot_id(seq),
            app,
            window: Some(window),
            elements,
            focused_element_id: focused,
            truncated,
            node_count: nodes as u64,
            elapsed_ms: u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
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
        let target = if let Some(region) = &request.region {
            CaptureTarget::Region(region.clone())
        } else if let Some(display) = &request.display {
            CaptureTarget::Display {
                raw_id: display.rsplit(':').next().and_then(|n| n.parse().ok()),
            }
        } else {
            let (_, window) = Self::select(
                request.app.as_deref(),
                request.pid,
                request.window.as_deref(),
            )?;
            if window.minimized {
                return Err(failure(
                    ComputerErrorCode::WindowMinimized,
                    "Restore the target window first",
                ));
            }
            CaptureTarget::Window {
                raw_id: capture::parse_window_id(&window.id).ok_or_else(|| {
                    failure(ComputerErrorCode::WindowNotFound, "Invalid window id")
                })?,
                frame: window.frame,
            }
        };
        capture::capture(
            &target,
            &CaptureOutput {
                format: request.format.unwrap_or(ComputerImageFormat::Png),
                max_width: request.max_width.and_then(|n| u32::try_from(n.get()).ok()),
                path: request.out.as_ref().map(std::path::PathBuf::from),
                directory: ctx.screenshots_dir.clone(),
                inline: request.base64 == Some(true),
            },
            hide_pids,
        )
    }
    fn resolve(&mut self, request: &ResolveRequest) -> ComputerResult<Resolved> {
        let (app, window, element, point) = if let Some(id) = &request.element {
            let (app, window, element, _) = self.element(id)?;
            let point = element.frame.as_ref().map(rect_center);
            (app, window, Some(element), point)
        } else {
            let (app, window) = Self::select(
                request.app.as_deref(),
                request.pid,
                request.window.as_deref(),
            )?;
            (app, window, None, request.point.clone())
        };
        let covered = point.as_ref().is_some_and(|p| ffi::point_pid(p) != app.pid);
        Ok(Resolved {
            app,
            window: Some(window),
            element,
            point,
            covered,
        })
    }
    fn click(
        &mut self,
        ctx: &Context,
        request: &ComputerClickRequest,
    ) -> ComputerResult<Performed> {
        ctx.stop.check()?;
        if let Some(id) = &request.element {
            let (app, _, element, handle) = self.element(id)?;
            ffi::refuse_elevated(u32::try_from(app.pid.unwrap_or(0)).unwrap_or_default())?;
            if request.method != Some(ComputerMethod::Pointer)
                && request.button.unwrap_or(ComputerMouseButton::Left) == ComputerMouseButton::Left
                && request.count.unwrap_or(std::num::NonZero::<u64>::MIN).get() == 1
                && request.modifiers.is_empty()
            {
                if ffi::invoke(&handle).is_ok() {
                    return Ok(performed(ComputerMethod::Ax, false, Some(element)));
                }
                if request.method == Some(ComputerMethod::Ax) {
                    return Err(failure(
                        ComputerErrorCode::ElementNotFound,
                        "Control has no Invoke pattern",
                    ));
                }
            }
        }
        let point = match (request.x, request.y) {
            (Some(x), Some(y)) => Some(ComputerPoint { x, y }),
            _ => None,
        };
        let target = self.pointer_target(&resolve_request(
            request.app.clone(),
            request.pid,
            request.element.clone(),
            point,
        ))?;
        let point = target.point.ok_or_else(|| {
            failure(
                ComputerErrorCode::InvalidPayload,
                "Click requires an element or x/y",
            )
        })?;
        if request.allow_outside_window != Some(true)
            && target
                .window
                .as_ref()
                .is_none_or(|w| !rect_contains(&w.frame, &point))
        {
            return Err(failure(
                ComputerErrorCode::InvalidPayload,
                "Point is outside the target window",
            ));
        }
        let (_, window, foreground) = Self::pointer_window(Some(&target.app.id), target.app.pid)?;
        if !foreground && !request.modifiers.is_empty() {
            // Modifiers are keyboard events: without the foreground they would
            // land in whichever app currently owns it.
            return Err(failure(
                ComputerErrorCode::TargetChanged,
                "Target did not become foreground",
            ));
        }
        if ffi::point_pid(&point) != Some(window.pid) {
            return Err(failure(
                ComputerErrorCode::TargetChanged,
                "Another window covers the click target",
            ));
        }
        input::with_modifiers(ctx, window.pid, &request.modifiers, || {
            input::click(
                ctx,
                window.pid,
                &point,
                request.button.unwrap_or(ComputerMouseButton::Left),
                request.count.map_or(1, std::num::NonZero::get),
            )
        })?;
        Ok(performed(ComputerMethod::Pointer, true, target.element))
    }
    fn type_text(
        &mut self,
        ctx: &Context,
        request: &ComputerTypeRequest,
    ) -> ComputerResult<Performed> {
        ctx.stop.check()?;
        let mut target = None;
        let mut app = request.app.clone();
        let mut pid = request.pid;
        if let Some(id) = &request.element {
            let (a, _, e, handle) = self.element(id)?;
            ffi::refuse_elevated(u32::try_from(a.pid.unwrap_or(0)).unwrap_or_default())?;
            app = Some(a.id);
            pid = a.pid;
            if e.secure && request.secret != Some(true) {
                return Err(failure(
                    ComputerErrorCode::NotAuthorized,
                    "Secure input requires secret=true",
                ));
            }
            if !e.secure && request.method != Some(ComputerMethod::Keys) {
                let text = if request.replace == Some(true) {
                    request.text.clone()
                } else {
                    format!("{}{}", e.value.as_deref().unwrap_or(""), request.text)
                };
                if ffi::set_value(&handle, &text).is_ok() {
                    if request.submit == Some(true) {
                        let (_, w) = Self::input_target(app.as_deref(), pid)?;
                        input::chord(ctx, w.pid, "enter")?;
                    }
                    return Ok(performed(ComputerMethod::Ax, false, Some(e)));
                }
            }
            ffi::focus_element(&handle)?;
            target = Some(e);
        }
        let (_, window) = Self::input_target(app.as_deref(), pid)?;
        if request.replace == Some(true) {
            input::chord(ctx, window.pid, "mod+a")?;
        }
        input::text(ctx, window.pid, &request.text)?;
        if request.submit == Some(true) {
            input::chord(ctx, window.pid, "enter")?;
        }
        Ok(performed(ComputerMethod::Keys, false, target))
    }
    fn key(&mut self, ctx: &Context, request: &ComputerKeyRequest) -> ComputerResult<Performed> {
        let (_, window) = Self::input_target(request.app.as_deref(), request.pid)?;
        for _ in 0..request.repeat.map_or(1, std::num::NonZero::get).min(100) {
            for chord in &request.chords {
                input::chord(ctx, window.pid, chord)?;
            }
        }
        Ok(performed(ComputerMethod::Keys, false, None))
    }
    fn scroll(
        &mut self,
        ctx: &Context,
        request: &ComputerScrollRequest,
    ) -> ComputerResult<Performed> {
        let target = self.resolve(&resolve_request(
            request.app.clone(),
            request.pid,
            request.element.clone(),
            match (request.x, request.y) {
                (Some(x), Some(y)) => Some(ComputerPoint { x, y }),
                _ => None,
            },
        ))?;
        // The wheel goes to the focused window unless the user has "scroll
        // inactive windows" on, so a scroll still needs the real foreground.
        let (_, window) = Self::input_target(Some(&target.app.id), target.app.pid)?;
        let point = target
            .point
            .or_else(|| target.window.as_ref().map(|w| rect_center(&w.frame)))
            .ok_or_else(|| failure(ComputerErrorCode::WindowNotFound, "No scroll target"))?;
        input::move_to(ctx, window.pid, &point)?;
        let amount = i32::try_from(request.amount.map_or(3, std::num::NonZero::get).min(100))
            .unwrap_or(100)
            * 120;
        let horizontal = matches!(
            request.direction,
            ComputerScrollDirection::Left | ComputerScrollDirection::Right
        );
        let sign = if matches!(
            request.direction,
            ComputerScrollDirection::Down | ComputerScrollDirection::Left
        ) {
            -1
        } else {
            1
        };
        input::scroll(ctx, window.pid, sign * amount, horizontal)?;
        Ok(performed(ComputerMethod::Pointer, true, None))
    }
    fn move_pointer(
        &mut self,
        ctx: &Context,
        request: &ComputerMoveRequest,
    ) -> ComputerResult<Performed> {
        let target = self.resolve(&resolve_request(
            request.app.clone(),
            request.pid,
            request.element.clone(),
            match (request.x, request.y) {
                (Some(x), Some(y)) => Some(ComputerPoint { x, y }),
                _ => None,
            },
        ))?;
        if request.visual_only != Some(true) {
            let (_, w, _) = Self::pointer_window(Some(&target.app.id), target.app.pid)?;
            input::move_to(
                ctx,
                w.pid,
                &target
                    .point
                    .ok_or_else(|| failure(ComputerErrorCode::InvalidPayload, "No move point"))?,
            )?;
        }
        Ok(performed(
            ComputerMethod::Pointer,
            request.visual_only != Some(true),
            target.element,
        ))
    }
    fn drag(&mut self, ctx: &Context, request: &ComputerDragRequest) -> ComputerResult<Performed> {
        let from = if let Some(point) = parse_point(&request.from) {
            point
        } else {
            self.element(&request.from)?
                .2
                .frame
                .as_ref()
                .map(rect_center)
                .ok_or_else(|| {
                    failure(
                        ComputerErrorCode::ElementNotFound,
                        "Drag source has no frame",
                    )
                })?
        };
        let to = if let Some(point) = parse_point(&request.to) {
            point
        } else {
            self.element(&request.to)?
                .2
                .frame
                .as_ref()
                .map(rect_center)
                .ok_or_else(|| {
                    failure(
                        ComputerErrorCode::ElementNotFound,
                        "Drag destination has no frame",
                    )
                })?
        };
        let (_, w, _) = Self::pointer_window(request.app.as_deref(), request.pid)?;
        input::drag(ctx, w.pid, &from, &to, request.duration_ms.unwrap_or(500))?;
        Ok(performed(ComputerMethod::Pointer, true, None))
    }
    fn user_activity(&mut self, pid: Option<u64>) -> Option<UserActivity> {
        user_activity(pid)
    }
}

fn walk_limits(request: &ComputerInspectRequest) -> WalkLimits {
    WalkLimits::new(
        request.max_nodes.map(std::num::NonZero::get),
        request.max_depth.map(std::num::NonZero::get),
        request.include_offscreen == Some(true),
    )
}

fn walk_exhausted(nodes: usize, limits: &WalkLimits, start: Instant) -> bool {
    nodes >= limits.max_nodes || start.elapsed() >= limits.budget
}

fn refuse_minimized(window: &ComputerWindow) -> ComputerResult<()> {
    if window.minimized {
        Err(failure(
            ComputerErrorCode::WindowMinimized,
            "Restore the target window first",
        ))
    } else {
        Ok(())
    }
}

/// Physical input probe shared with native action cancellation.
pub(super) fn user_activity(pid: Option<u64>) -> Option<UserActivity> {
    let point = ffi::pointer()?;
    Some(UserActivity {
        keyboard_seconds: ffi::physical_keyboard_seconds(),
        pointer_seconds: ffi::physical_pointer_seconds(),
        target_frontmost: ffi::foreground_pid() == pid,
        pointer_over_target: ffi::point_pid(&point) == pid,
    })
}

#[cfg(test)]
mod tests {
    use super::matches_app;
    use pragma_constants::ComputerApp;

    fn app(path: &str) -> ComputerApp {
        ComputerApp {
            id: format!("app:win:{}", path.to_lowercase()),
            name: path.to_string(),
            bundle_id: None,
            path: Some(path.to_string()),
            pid: Some(42),
            running: true,
            frontmost: false,
            hidden: None,
            blocked: None,
        }
    }

    /// Agents and the CLI name an app "notepad"; xcap names the window after its
    /// executable path. Matching only the full file name made `open` launch a
    /// second copy (and then time out waiting for a window it already had).
    #[test]
    fn a_program_name_matches_its_executable_stem() {
        let notepad = app(r"C:\Program Files\WindowsApps\Microsoft.WindowsNotepad\Notepad.exe");
        for name in [
            "notepad",
            "notepad.exe",
            "Notepad.EXE",
            r"C:\Program Files\WindowsApps\Microsoft.WindowsNotepad\Notepad.exe",
        ] {
            assert!(matches_app(&notepad, name), "{name}");
        }
        assert!(!matches_app(&notepad, "paint"));
    }
}
