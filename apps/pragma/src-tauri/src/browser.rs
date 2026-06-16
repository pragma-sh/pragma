//! Native browser tabs.
//!
//! Each browser tab is a real child [`tauri::Webview`] embedded in the main
//! window (Tauri's multiwebview API, behind the `unstable` feature) rather than
//! an iframe — only a native webview can run dev tools, clear its own cookies, and
//! load pages that forbid framing. The React side owns the chrome (tab strip +
//! toolbar) and renders a placeholder `<div>`; the native webview floats on top
//! of that div, kept in sync via [`browser_set_bounds`] / [`browser_set_visible`].
//!
//! Tauri already tracks webviews by label, so there is no custom registry here —
//! the label (`browser-{tabId}`) is the single source of truth. Page title and
//! URL changes are reported to the frontend via the [`META_EVENT`] event using
//! Tauri's native `on_document_title_changed` / `on_navigation` hooks, so we never
//! expose the IPC surface to arbitrary remote pages.

use tauri::webview::WebviewBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl,
    Window,
};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};

/// Label of the main window the browser webviews are children of.
const MAIN_WINDOW_LABEL: &str = "main";
/// Event name carrying `{ tabId, title?, url? }` page metadata to the frontend.
const META_EVENT: &str = "browser-meta";
/// Event name emitted by a browser webview when the user interacts with its content.
const FOCUS_REQUEST_EVENT: &str = "browser-focus-request";
/// URL scheme the injected [`focus_script`] navigates to when its page gains
/// focus. It is a one-way "this page was focused" ping back to Rust: the
/// navigation handler recognizes the scheme, reports focus to the frontend, and
/// cancels the navigation so the page never actually leaves. This reuses the
/// native navigation hook (like title/URL reporting) instead of exposing the IPC
/// surface to arbitrary remote pages — `window.__TAURI_INTERNALS__` is not
/// available on remote origins, so an IPC `emit` would silently no-op there.
const FOCUS_SENTINEL_SCHEME: &str = "pragma-focus";

/// Page-focus ping reported to the frontend so split-pane focus can follow a
/// click into a native browser webview's content.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserFocusRequest {
    tab_id: String,
}

/// Page metadata reported to the frontend as a browser webview navigates.
///
/// `title` and `url` are independently optional: a title change emits only the
/// title, a navigation emits only the URL. The frontend treats absent fields as
/// "unchanged".
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserMeta {
    tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

/// Derives the child-webview label that hosts a given tab's page.
fn webview_label(tab_id: &str) -> String {
    format!("browser-{tab_id}")
}

/// Injects a small script into every browser page so that interacting with the
/// native webview surface is forwarded to the React frontend, which can then move
/// split-pane focus to the correct pane.
///
/// The page signals focus by navigating to the [`FOCUS_SENTINEL_SCHEME`] URL,
/// which the navigation hook intercepts and cancels — this works on remote pages,
/// where the Tauri IPC bridge is intentionally absent. The ping fires once per
/// focus session (reset on blur) so normal clicks and link navigations are
/// untouched.
fn focus_script() -> String {
    format!(
        r"
(function() {{
  let signalled = false;
  function signal() {{
    if (signalled) return;
    signalled = true;
    // Cancelled navigation used as a focus ping; see FOCUS_SENTINEL_SCHEME (Rust).
    window.location.href = '{FOCUS_SENTINEL_SCHEME}:focus';
  }}
  window.addEventListener('focus', signal, true);
  window.addEventListener('pointerdown', signal, true);
  window.addEventListener('blur', function() {{ signalled = false; }}, true);
}})();
"
    )
}

/// Returns the main window (the multiwebview host for all browser tabs).
fn main_window(app: &AppHandle) -> AppResult<Window> {
    app.get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| AppError::Browser("main window is not available".to_string()))
}

/// Height of the window's outer frame, in logical pixels.
///
/// Tauri positions embedded child webviews relative to the window frame, but the
/// React placeholder's `getBoundingClientRect` is relative to the content
/// viewport, which sits below the title bar. The frontend recovers the title-bar
/// inset as `frameHeight - window.innerHeight` (both reliable; no screen
/// coordinates) and offsets the webview by it. macOS reports `inner_size`
/// identically to the frame, so this is the only place the real frame height is
/// available.
#[tauri::command]
pub fn browser_frame_height(app: tauri::AppHandle) -> AppResult<f64> {
    let window = main_window(&app)?;
    let scale = window.scale_factor().unwrap_or(1.0);
    Ok(f64::from(window.outer_size()?.height) / scale)
}

/// Looks up the live webview for a browser tab, erroring if it is gone.
fn require_webview(app: &AppHandle, tab_id: &str) -> AppResult<Webview> {
    app.get_webview(&webview_label(tab_id))
        .ok_or_else(|| AppError::Browser(format!("no browser webview for tab {tab_id}")))
}

/// Normalizes address-bar text into a URL, defaulting to `https://` when the
/// user omits a scheme (so typing `example.com` just works).
fn parse_url(input: &str) -> AppResult<Url> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::Browser("empty url".to_string()));
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    Url::parse(&candidate)
        .map_err(|error| AppError::Browser(format!("invalid url '{input}': {error}")))
}

/// Emits page metadata to the frontend, ignoring the (benign) error when the
/// main webview has gone away during shutdown.
fn emit_meta(app: &AppHandle, meta: &BrowserMeta) {
    let _ = app.emit(META_EVENT, meta);
}

/// Creates the native browser webview for a tab at the given logical bounds.
///
/// Bounds are CSS pixels in the content coordinate space (the same as the React
/// placeholder's `getBoundingClientRect`); [`content_offset`] translates them into
/// the outer-frame space Tauri positions child webviews in. Re-creating an
/// existing tab just repositions it.
#[tauri::command]
pub fn browser_create(
    app: tauri::AppHandle,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> AppResult<()> {
    if app.get_webview(&webview_label(&tab_id)).is_some() {
        return browser_set_bounds(app, tab_id, x, y, width, height);
    }
    let window = main_window(&app)?;
    let start_url = parse_url(&url)?;
    let label = webview_label(&tab_id);

    let title_app = app.clone();
    let title_tab = tab_id.clone();
    let nav_app = app.clone();
    let nav_tab = tab_id.clone();

    let builder = WebviewBuilder::new(label, WebviewUrl::External(start_url))
        .initialization_script(focus_script())
        .on_document_title_changed(move |_webview, title| {
            emit_meta(
                &title_app,
                &BrowserMeta {
                    tab_id: title_tab.clone(),
                    title: Some(title),
                    url: None,
                },
            );
        })
        .on_navigation(move |url| {
            // A focus ping, not a real navigation: report it and cancel the load.
            if url.scheme() == FOCUS_SENTINEL_SCHEME {
                let _ = nav_app.emit(
                    FOCUS_REQUEST_EVENT,
                    BrowserFocusRequest {
                        tab_id: nav_tab.clone(),
                    },
                );
                return false;
            }
            emit_meta(
                &nav_app,
                &BrowserMeta {
                    tab_id: nav_tab.clone(),
                    title: None,
                    url: Some(url.to_string()),
                },
            );
            true
        });

    window.add_child(
        builder,
        LogicalPosition::new(x, y),
        LogicalSize::new(width.max(0.0), height.max(0.0)),
    )?;
    Ok(())
}

/// Repositions/resizes a browser webview to track its React placeholder.
#[tauri::command]
pub fn browser_set_bounds(
    app: tauri::AppHandle,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> AppResult<()> {
    if let Some(webview) = app.get_webview(&webview_label(&tab_id)) {
        webview.set_bounds(Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width.max(0.0), height.max(0.0)).into(),
        })?;
    }
    Ok(())
}

/// Shows or hides a browser webview when its tab gains or loses focus.
#[tauri::command]
pub fn browser_set_visible(app: tauri::AppHandle, tab_id: String, visible: bool) -> AppResult<()> {
    if let Some(webview) = app.get_webview(&webview_label(&tab_id)) {
        if visible {
            webview.show()?;
        } else {
            webview.hide()?;
        }
    }
    Ok(())
}

/// Moves keyboard focus to a browser webview when its pane is focused.
#[tauri::command]
pub fn browser_focus(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    require_webview(&app, &tab_id)?
        .set_focus()
        .map_err(|error| AppError::Browser(format!("failed to focus browser: {error}")))?;
    Ok(())
}

/// Navigates a browser webview to a new URL (address-bar submit).
#[tauri::command]
pub fn browser_navigate(app: tauri::AppHandle, tab_id: String, url: String) -> AppResult<()> {
    require_webview(&app, &tab_id)?.navigate(parse_url(&url)?)?;
    Ok(())
}

/// Navigates back in the webview's session history.
#[tauri::command]
pub fn browser_back(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    require_webview(&app, &tab_id)?.eval("history.back()")?;
    Ok(())
}

/// Navigates forward in the webview's session history.
#[tauri::command]
pub fn browser_forward(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    require_webview(&app, &tab_id)?.eval("history.forward()")?;
    Ok(())
}

/// Reloads the current page.
#[tauri::command]
pub fn browser_reload(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    require_webview(&app, &tab_id)?.eval("location.reload()")?;
    Ok(())
}

/// Opens the native dev tools inspector for a browser webview.
///
/// Enabled in release builds too via the `devtools` Cargo feature; opens in a
/// separate inspector window.
#[tauri::command]
pub fn browser_devtools(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    require_webview(&app, &tab_id)?.open_devtools();
    Ok(())
}

/// Clears all browsing data (cookies + cache + storage) for a browser webview.
///
/// The native API clears these together; there is no reliable cross-platform
/// (macOS + Linux) split, so the UI exposes a single "Clear browsing data".
#[tauri::command]
pub fn browser_clear_data(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    require_webview(&app, &tab_id)?.clear_all_browsing_data()?;
    Ok(())
}

/// Opens the given URL in the user's default system browser.
#[tauri::command]
pub fn browser_open_external(url: String) -> AppResult<()> {
    let url = parse_url(&url)?;
    opener::open(url.as_str())
        .map_err(|error| AppError::Browser(format!("failed to open external browser: {error}")))
}

/// Destroys the native webview backing a browser tab.
#[tauri::command]
pub fn browser_close(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    if let Some(webview) = app.get_webview(&webview_label(&tab_id)) {
        webview.close()?;
    }
    Ok(())
}

/// Screenshots the page region and saves it via a native save dialog.
///
/// `x`/`y`/`width`/`height` are **physical screen pixels** of the page area
/// (the frontend computes them from the placeholder rect plus the window's screen
/// offset and device pixel ratio). Returns the saved path, or `None` if the user
/// cancelled the dialog.
#[tauri::command]
pub fn browser_screenshot(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> AppResult<Option<String>> {
    let image = capture_region(x, y, width, height)?;
    let Some(target) = app
        .dialog()
        .file()
        .set_file_name("pragma-screenshot.png")
        .add_filter("PNG image", &["png"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = target
        .into_path()
        .map_err(|error| AppError::Browser(format!("invalid save path: {error}")))?;
    image
        .save(&path)
        .map_err(|error| AppError::Browser(format!("failed to save screenshot: {error}")))?;
    Ok(Some(path.display().to_string()))
}

/// Captures the page region and returns it as a `data:image/png;base64,...` URL.
///
/// Used to paint a still of the live page while an HTML overlay (dropdown,
/// popover) is open over a browser pane: the native webview composites above all
/// HTML and so must be hidden for the overlay to show, but swapping in this
/// snapshot keeps the pane looking unchanged. Coordinates are **physical screen
/// pixels** of the page area, same as [`browser_screenshot`]. The caller must
/// capture *before* hiding the webview, while the live page is still on screen.
#[tauri::command]
pub fn browser_snapshot(x: f64, y: f64, width: f64, height: f64) -> AppResult<String> {
    use base64::Engine;

    let image = capture_region(x, y, width, height)?;
    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, xcap::image::ImageFormat::Png)
        .map_err(|error| AppError::Browser(format!("failed to encode snapshot: {error}")))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
    Ok(format!("data:image/png;base64,{encoded}"))
}

/// Maps an `xcap` capture error into our application error type.
fn xcap_err(error: xcap::XCapError) -> AppError {
    AppError::Browser(format!("screen capture failed: {error}"))
}

/// Captures a rectangle of physical screen pixels into an RGBA image by grabbing
/// the monitor that contains the region and cropping to it.
fn capture_region(x: f64, y: f64, width: f64, height: f64) -> AppResult<xcap::image::RgbaImage> {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let (x, y, width, height) = (
        x.round() as i32,
        y.round() as i32,
        width.round().max(1.0) as u32,
        height.round().max(1.0) as u32,
    );

    let monitors = xcap::Monitor::all().map_err(xcap_err)?;
    let mut chosen = None;
    for monitor in monitors {
        let mx = monitor.x().map_err(xcap_err)?;
        let my = monitor.y().map_err(xcap_err)?;
        #[allow(clippy::cast_possible_wrap)]
        let mw = monitor.width().map_err(xcap_err)? as i32;
        #[allow(clippy::cast_possible_wrap)]
        let mh = monitor.height().map_err(xcap_err)? as i32;
        if x >= mx && y >= my && x < mx + mw && y < my + mh {
            chosen = Some((monitor, mx, my));
            break;
        }
    }
    let (monitor, mx, my) =
        chosen.ok_or_else(|| AppError::Browser("page is not on any monitor".to_string()))?;

    let shot = monitor.capture_image().map_err(xcap_err)?;
    #[allow(clippy::cast_sign_loss)]
    let local_x = (x - mx) as u32;
    #[allow(clippy::cast_sign_loss)]
    let local_y = (y - my) as u32;
    let crop_w = width.min(shot.width().saturating_sub(local_x));
    let crop_h = height.min(shot.height().saturating_sub(local_y));

    Ok(xcap::image::imageops::crop_imm(&shot, local_x, local_y, crop_w, crop_h).to_image())
}
