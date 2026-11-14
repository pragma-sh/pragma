//! A deterministic in-memory backend for tests: two apps, one window, a small
//! accessibility tree, and a log of every action it was asked to perform.
//!
//! The server's tests drive the full `computer` RPC (sessions, leases, policy,
//! activity) through this, so they run on any platform and in CI without an
//! accessibility grant or a display.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use pragma_constants::{
    ComputerApp, ComputerAppsRequest, ComputerClickRequest, ComputerDisplay, ComputerDragRequest,
    ComputerElement, ComputerErrorCode, ComputerFocusRequest, ComputerInspectRequest,
    ComputerKeyRequest, ComputerMethod, ComputerMoveRequest, ComputerOpenRequest,
    ComputerPermissionState, ComputerPermissions, ComputerPermissionsRequest, ComputerPoint,
    ComputerRect, ComputerScreenshot, ComputerScreenshotRequest, ComputerScrollRequest,
    ComputerSnapshot, ComputerTypeRequest, ComputerWindow, ComputerWindowsRequest,
};
use pragma_core::computer::{matches_query, rect_center, snapshot_id};

use crate::snapshot::{to_element, RawNode, SnapshotRing};
use crate::{
    failure, ComputerBackend, ComputerResult, Context, Focused, Performed, ResolveRequest,
    Resolved, UserActivity,
};

/// The fake backend. Clone the [`FakeBackend::log`] handle before moving the
/// backend into a helper to read what it did.
#[derive(Default)]
pub struct FakeBackend {
    /// Override OS grants to exercise first-use setup through the host.
    pub permissions: Arc<Mutex<Option<ComputerPermissions>>>,
    /// Every action performed, as `op target` lines.
    pub log: Arc<Mutex<Vec<String>>>,
    /// While set, the user is typing right now (into whichever app is frontmost).
    pub typing: Arc<AtomicBool>,
    ring: SnapshotRing<()>,
    urls: std::collections::HashMap<u64, String>,
    values: std::collections::HashMap<String, String>,
}

const TEXTEDIT_PID: u64 = 4242;
const SAFARI_PID: u64 = 4343;

fn app(name: &str, bundle: &str, pid: u64, frontmost: bool) -> ComputerApp {
    ComputerApp {
        id: format!("app:mac:{bundle}"),
        name: name.to_string(),
        bundle_id: Some(bundle.to_string()),
        path: None,
        pid: Some(pid),
        running: true,
        frontmost,
        hidden: None,
        blocked: None,
    }
}

fn apps() -> Vec<ComputerApp> {
    vec![
        app("TextEdit", "com.apple.TextEdit", TEXTEDIT_PID, true),
        app("Safari", "com.apple.Safari", SAFARI_PID, false),
    ]
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> ComputerRect {
    ComputerRect {
        x,
        y,
        w,
        h,
        display_id: Some("display:mac:1".to_string()),
    }
}

fn window_for(app: &ComputerApp) -> ComputerWindow {
    ComputerWindow {
        id: format!("win:mac:{}", app.pid.unwrap_or(0)),
        app_id: app.id.clone(),
        app_name: app.name.clone(),
        pid: app.pid.unwrap_or(0),
        title: format!("{} window", app.name),
        frame: rect(100.0, 100.0, 800.0, 600.0),
        focused: app.frontmost,
        minimized: false,
        on_screen: true,
    }
}

fn find_app(name: Option<&str>, pid: Option<u64>) -> ComputerResult<ComputerApp> {
    let all = apps();
    if let Some(pid) = pid {
        return all
            .into_iter()
            .find(|app| app.pid == Some(pid))
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::AppNotFound,
                    format!("no app with pid {pid}"),
                )
            });
    }
    match name {
        None => Ok(all
            .into_iter()
            .find(|app| app.frontmost)
            .unwrap_or_else(|| apps()[0].clone())),
        Some(name) => all
            .into_iter()
            .find(|app| {
                app.name.eq_ignore_ascii_case(name)
                    || app.id.eq_ignore_ascii_case(name)
                    || app
                        .bundle_id
                        .as_deref()
                        .is_some_and(|b| b.eq_ignore_ascii_case(name))
            })
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::AppNotFound,
                    format!("no app named `{name}`"),
                )
            }),
    }
}

fn nodes() -> Vec<RawNode> {
    let node =
        |role: &str, title: &str, path: Vec<u64>, frame: ComputerRect, editable: bool| RawNode {
            role: role.to_string(),
            title: Some(title.to_string()),
            frame: Some(frame),
            enabled: true,
            editable,
            actions: if editable {
                Vec::new()
            } else {
                vec!["press".to_string()]
            },
            path,
            ancestor_roles: vec!["AXWindow".to_string()],
            ..RawNode::default()
        };
    vec![
        node(
            "AXButton",
            "Save",
            vec![0],
            rect(120.0, 120.0, 80.0, 24.0),
            false,
        ),
        node(
            "AXButton",
            "Delete",
            vec![1],
            rect(220.0, 120.0, 80.0, 24.0),
            false,
        ),
        node(
            "AXTextField",
            "Name",
            vec![2],
            rect(120.0, 160.0, 300.0, 24.0),
            true,
        ),
    ]
}

impl FakeBackend {
    fn record(&self, line: String) {
        if let Ok(mut log) = self.log.lock() {
            log.push(line);
        }
    }

    fn element(&self, id: &str) -> ComputerResult<(ComputerApp, ComputerElement)> {
        let (snapshot, index) = self.ring.lookup(id)?;
        let app = find_app(None, Some(snapshot.pid))?;
        Ok((app, snapshot.elements[index].clone()))
    }
}

impl ComputerBackend for FakeBackend {
    fn permissions(
        &mut self,
        _request: &ComputerPermissionsRequest,
    ) -> ComputerResult<ComputerPermissions> {
        if let Some(permissions) = self.permissions.lock().ok().and_then(|p| p.clone()) {
            return Ok(permissions);
        }
        Ok(ComputerPermissions {
            platform: "fake".to_string(),
            supported: true,
            accessibility: ComputerPermissionState::Granted,
            screen_recording: ComputerPermissionState::Granted,
        })
    }

    fn displays(&mut self) -> ComputerResult<Vec<ComputerDisplay>> {
        Ok(vec![ComputerDisplay {
            id: "display:mac:1".to_string(),
            frame: rect(0.0, 0.0, 1440.0, 900.0),
            scale: 2.0,
            primary: true,
        }])
    }

    fn apps(&mut self, request: &ComputerAppsRequest) -> ComputerResult<Vec<ComputerApp>> {
        let query = request.query.as_deref().unwrap_or_default().to_lowercase();
        Ok(apps()
            .into_iter()
            .filter(|app| app.name.to_lowercase().contains(&query))
            .collect())
    }

    fn windows(&mut self, request: &ComputerWindowsRequest) -> ComputerResult<Vec<ComputerWindow>> {
        if request.app.is_none() && request.pid.is_none() {
            return Ok(apps().iter().map(window_for).collect());
        }
        Ok(vec![window_for(&find_app(
            request.app.as_deref(),
            request.pid,
        )?)])
    }

    fn open(&mut self, _ctx: &Context, request: &ComputerOpenRequest) -> ComputerResult<Focused> {
        let app = find_app(request.app.as_deref(), request.pid)?;
        let front = if request.activate == Some(true) {
            " to front"
        } else {
            ""
        };
        self.record(format!("open {}{front}", app.name));
        if let (Some(pid), Some(url)) = (app.pid, &request.url) {
            self.urls.insert(pid, url.clone());
        }
        Ok(Focused {
            window: Some(window_for(&app)),
            app,
        })
    }

    fn focus(&mut self, _ctx: &Context, request: &ComputerFocusRequest) -> ComputerResult<Focused> {
        let app = find_app(request.app.as_deref(), request.pid)?;
        let front = if request.activate == Some(true) {
            " to front"
        } else {
            ""
        };
        self.record(format!("focus {}{front}", app.name));
        Ok(Focused {
            window: Some(window_for(&app)),
            app,
        })
    }

    fn inspect(&mut self, request: &ComputerInspectRequest) -> ComputerResult<ComputerSnapshot> {
        let app = find_app(request.app.as_deref(), request.pid)?;
        let seq = self.ring.next_seq();
        let query = request.query.as_deref().unwrap_or_default();
        let mut elements = Vec::new();
        for node in nodes() {
            let label = node.title.clone().unwrap_or_default();
            let index = u32::try_from(elements.len()).unwrap_or(u32::MAX);
            let mut element = to_element(seq, index, &node, label, true);
            element.focused = element.editable;
            if let Some(value) = self.values.get(&element.key) {
                element.value = Some(value.clone());
            }
            if matches_query(&element, query) {
                elements.push(element);
            }
        }
        // Re-number after filtering so ids stay dense, as the real walk does.
        for (index, element) in elements.iter_mut().enumerate() {
            element.id = format!("s{seq}:e{index}");
        }
        let window = window_for(&app);
        self.ring.insert(
            seq,
            app.pid.unwrap_or(0),
            Some(window.id.clone()),
            elements.clone(),
            vec![(); elements.len()],
        );
        Ok(ComputerSnapshot {
            url: self.urls.get(&app.pid.unwrap_or_default()).cloned(),
            id: snapshot_id(seq),
            app,
            window: Some(window),
            focused_element_id: None,
            truncated: false,
            node_count: 3,
            elapsed_ms: 1,
            created_at: 0,
            untrusted: true,
            elements,
        })
    }

    fn screenshot(
        &mut self,
        ctx: &Context,
        request: &ComputerScreenshotRequest,
        hide_pids: &[u64],
    ) -> ComputerResult<ComputerScreenshot> {
        // A real 1×1 PNG, so a test that opens the file gets an image; the
        // fake never needs the native capture stack.
        const PIXEL: &[u8] = &[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ];
        if !hide_pids.is_empty() {
            self.record(format!("screenshot hiding {hide_pids:?}"));
        }
        let id = format!("shot_{}", uuid::Uuid::new_v4().simple());
        let path = ctx.screenshots_dir.join(format!("{id}.png"));
        std::fs::create_dir_all(&ctx.screenshots_dir)
            .and_then(|()| std::fs::write(&path, PIXEL))
            .map_err(|error| failure(ComputerErrorCode::Internal, error.to_string()))?;
        Ok(ComputerScreenshot {
            id,
            path: path.to_string_lossy().into_owned(),
            width: 1,
            height: 1,
            origin: ComputerPoint { x: 100.0, y: 100.0 },
            scale: 2.0,
            format: pragma_constants::ComputerImageFormat::Png,
            bytes: PIXEL.len() as u64,
            base64: (request.base64 == Some(true))
                .then(|| base64::engine::general_purpose::STANDARD.encode(PIXEL)),
        })
    }

    fn resolve(&mut self, request: &ResolveRequest) -> ComputerResult<Resolved> {
        if let Some(id) = &request.element {
            let (app, element) = self.element(id)?;
            return Ok(Resolved {
                covered: false,
                window: Some(window_for(&app)),
                point: element.frame.as_ref().map(rect_center),
                element: Some(element),
                app,
            });
        }
        let app = find_app(request.app.as_deref(), request.pid)?;
        Ok(Resolved {
            covered: false,
            window: Some(window_for(&app)),
            app,
            element: None,
            point: request.point.clone(),
        })
    }

    fn click(
        &mut self,
        ctx: &Context,
        request: &ComputerClickRequest,
    ) -> ComputerResult<Performed> {
        ctx.stop.check()?;
        if let Some(id) = &request.element {
            let (_, element) = self.element(id)?;
            self.record(format!("click {}", element.label));
            return Ok(Performed {
                method: ComputerMethod::Ax,
                physical_cursor: false,
                element: Some(element),
            });
        }
        let point = ComputerPoint {
            x: request.x.unwrap_or_default(),
            y: request.y.unwrap_or_default(),
        };
        self.record(format!("click {},{}", point.x, point.y));
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
        ctx.stop.check()?;
        self.record(format!("type {}", request.text));
        if let Some(id) = &request.element {
            let (_, element) = self.element(id)?;
            self.values.insert(element.key, request.text.clone());
        }
        Ok(Performed {
            method: ComputerMethod::Ax,
            physical_cursor: false,
            element: None,
        })
    }

    fn key(&mut self, ctx: &Context, request: &ComputerKeyRequest) -> ComputerResult<Performed> {
        ctx.stop.check()?;
        let target = request
            .pid
            .map(|pid| format!(" @{pid}"))
            .unwrap_or_default();
        self.record(format!("key {}{target}", request.chords.join(" ")));
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
        ctx.stop.check()?;
        self.record(format!("scroll {:?}", request.direction));
        Ok(Performed {
            method: ComputerMethod::Pointer,
            physical_cursor: true,
            element: None,
        })
    }

    fn move_pointer(
        &mut self,
        ctx: &Context,
        request: &ComputerMoveRequest,
    ) -> ComputerResult<Performed> {
        ctx.stop.check()?;
        self.record(format!("move {:?},{:?}", request.x, request.y));
        Ok(Performed {
            method: ComputerMethod::Pointer,
            physical_cursor: request.visual_only != Some(true),
            element: None,
        })
    }

    fn drag(&mut self, ctx: &Context, request: &ComputerDragRequest) -> ComputerResult<Performed> {
        ctx.stop.check()?;
        self.record(format!("drag {} {}", request.from, request.to));
        Ok(Performed {
            method: ComputerMethod::Pointer,
            physical_cursor: true,
            element: None,
        })
    }

    fn user_activity(&mut self, pid: Option<u64>) -> Option<UserActivity> {
        let typing = self.typing.load(Ordering::SeqCst);
        let frontmost = apps()
            .into_iter()
            .find(|app| app.frontmost)
            .and_then(|app| app.pid);
        Some(UserActivity {
            keyboard_seconds: typing.then_some(0.0),
            pointer_seconds: None,
            target_frontmost: pid.is_some() && pid == frontmost,
            pointer_over_target: false,
        })
    }
}
