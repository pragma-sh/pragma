//! Running and installed apps, and launching them.
//!
//! Running apps come from `NSWorkspace`, filtered to regular (Dock) apps.
//! Installed apps are the `.app` bundles in the standard folders. Launching
//! goes through `/usr/bin/open`, which is `LaunchServices`: it re-activates a
//! running instance instead of starting a second one, exactly as a user's
//! double-click would.

use std::path::{Path, PathBuf};

use objc2_app_kit::{NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace};
use pragma_constants::{ComputerApp, ComputerErrorCode};

use crate::{failure, ComputerResult};

/// One running app, with the handle needed to activate it.
pub struct Running {
    pub app: ComputerApp,
    pub handle: objc2::rc::Retained<NSRunningApplication>,
}

/// Regular running apps.
pub fn running() -> Vec<Running> {
    super::ffi::pump_run_loop();
    let workspace = NSWorkspace::sharedWorkspace();
    let frontmost = frontmost_pid();
    workspace
        .runningApplications()
        .iter()
        .filter(|app| app.activationPolicy() == NSApplicationActivationPolicy::Regular)
        .filter(|app| !app.isTerminated())
        .map(|handle| {
            let pid = handle.processIdentifier();
            let bundle_id = handle.bundleIdentifier().map(|id| id.to_string());
            let path = handle
                .bundleURL()
                .and_then(|url| url.path())
                .map(|path| path.to_string());
            let name = handle
                .localizedName()
                .map(|name| name.to_string())
                .unwrap_or_default();
            Running {
                app: ComputerApp {
                    id: app_id(bundle_id.as_deref(), path.as_deref(), &name),
                    name,
                    bundle_id,
                    path,
                    pid: u64::try_from(pid).ok(),
                    running: true,
                    frontmost: frontmost == Some(pid),
                    hidden: Some(handle.isHidden()),
                    blocked: None,
                },
                handle,
            }
        })
        .collect()
}

/// The frontmost app's pid.
///
/// `NSWorkspace` only keeps `frontmostApplication` current for a process with
/// a running app event loop, which this helper does not have, so it can be
/// stale or empty. The Window Server's list is always current: its first
/// normal-layer window belongs to the frontmost app.
pub fn frontmost_pid() -> Option<i32> {
    super::ffi::window_list()
        .into_iter()
        .find(|window| window.layer == 0 && window.w > 1.0 && window.h > 1.0)
        .map(|window| window.pid)
        .or_else(|| {
            NSWorkspace::sharedWorkspace()
                .frontmostApplication()
                .map(|app| app.processIdentifier())
        })
}

/// The stable id of an app.
#[must_use]
pub fn app_id(bundle_id: Option<&str>, path: Option<&str>, name: &str) -> String {
    match (bundle_id, path) {
        (Some(bundle), _) => format!("app:mac:{bundle}"),
        (None, Some(path)) => format!("app:mac:{path}"),
        (None, None) => format!("app:mac:{name}"),
    }
}

/// Installed `.app` bundles in the standard folders, one entry per bundle id.
pub fn installed() -> Vec<ComputerApp> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
        PathBuf::from("/System/Library/CoreServices/Applications"),
    ];
    if let Some(home) = pragma_platform::path::home_dir() {
        roots.push(home.join("Applications"));
    }
    let running = running();
    let mut out: Vec<ComputerApp> = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("app") {
                continue;
            }
            let Some(app) = bundle_app(&path) else {
                continue;
            };
            if out.iter().any(|existing| existing.id == app.id) {
                continue;
            }
            let live = running.iter().find(|r| r.app.id == app.id);
            out.push(ComputerApp {
                pid: live.and_then(|r| r.app.pid),
                running: live.is_some(),
                frontmost: live.is_some_and(|r| r.app.frontmost),
                ..app
            });
        }
    }
    out.sort_by_key(|app| app.name.to_lowercase());
    out
}

/// Reads a bundle's name and identifier from its `Info.plist`.
fn bundle_app(path: &Path) -> Option<ComputerApp> {
    let name = path.file_stem()?.to_string_lossy().into_owned();
    let bundle_id = read_bundle_id(path);
    let path_text = path.to_string_lossy().into_owned();
    Some(ComputerApp {
        id: app_id(bundle_id.as_deref(), Some(&path_text), &name),
        name,
        bundle_id,
        path: Some(path_text),
        pid: None,
        running: false,
        frontmost: false,
        hidden: None,
        blocked: None,
    })
}

/// The bundle id from `Contents/Info.plist`, which may be XML or binary.
///
/// `plutil -extract` reads both formats without a plist dependency.
fn read_bundle_id(path: &Path) -> Option<String> {
    let plist = path.join("Contents/Info.plist");
    let output = pragma_platform::process::command("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(&plist)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!id.is_empty()).then_some(id)
}

/// How `open` should launch.
pub struct LaunchSpec<'a> {
    pub bundle_id: Option<&'a str>,
    pub path: Option<&'a str>,
    pub name: Option<&'a str>,
    pub new_instance: bool,
    pub activate: bool,
    pub documents: Vec<&'a str>,
}

/// Launches (or re-activates) an app through `LaunchServices`.
pub fn launch(spec: &LaunchSpec<'_>) -> ComputerResult<()> {
    let mut command = pragma_platform::process::command("/usr/bin/open");
    if spec.new_instance {
        command.arg("-n");
    }
    if !spec.activate {
        command.arg("-g");
    }
    match (spec.bundle_id, spec.path, spec.name) {
        (Some(bundle), _, _) => {
            command.args(["-b", bundle]);
        }
        (None, Some(path), _) => {
            command.args(["-a", path]);
        }
        (None, None, Some(name)) => {
            command.args(["-a", name]);
        }
        (None, None, None) => {
            return Err(failure(
                ComputerErrorCode::InvalidPayload,
                "open needs an app",
            ));
        }
    }
    command.args(&spec.documents);
    let output = command
        .output()
        .map_err(|error| failure(ComputerErrorCode::Internal, format!("run open: {error}")))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(failure(
            ComputerErrorCode::AppNotFound,
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}
