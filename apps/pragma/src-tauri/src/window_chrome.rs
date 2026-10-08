//! Native window chrome: the window title, plus macOS vibrancy + inset traffic
//! lights. Applied to the main window and to every Pragma Mini window.
//!
//! Pragma uses a custom (frontend-painted) titlebar. On macOS we make the window
//! transparent and drop an `NSVisualEffectView` behind it ([`window-vibrancy`])
//! so the translucent project rail reveals the desktop blur, then nudge the
//! traffic-light buttons down so they center within the taller custom titlebar
//! ([`tauri-plugin-decorum`]).
//!
//! **The transparency is macOS-only, and deliberately so.** A transparent window
//! on Windows and Linux has nothing behind it — there is no vibrancy layer to
//! reveal — so the chrome the compositor draws around it (the Windows DWM title
//! bar, a GTK client-side header bar) renders see-through instead of solid.
//! `transparent`/`titleBarStyle`/`hiddenTitle` therefore live in
//! `tauri.macos.conf.json`, not the shared `tauri.conf.json`; those two files
//! carry the same window array because Tauri's config merge *replaces* arrays
//! rather than merging them, so a change to one has to be made in both.
//! Windows and Linux keep an opaque window with standard decorations.

use tauri::{Manager, WebviewWindow};

#[cfg(target_os = "macos")]
use pragma_constants::CONSTANTS;

/// Applies native window chrome to `window`. Failures are logged, never fatal:
/// a missing visual effect just falls back to the opaque charcoal surface.
pub fn apply(window: &WebviewWindow) {
    apply_titled(window, &product_name(window));
}

/// [`apply`] with an explicit title (a Pragma Mini window's "Pragma Mini").
pub fn apply_titled(window: &WebviewWindow, title: &str) {
    apply_title(window, title);
    #[cfg(target_os = "macos")]
    {
        // Mini windows are built on an async worker. AppKit's visual effect
        // must be installed on the main thread, even after the builder returns.
        let chrome_window = window.clone();
        if let Err(error) = window.run_on_main_thread(move || apply_macos(&chrome_window)) {
            log::warn!("failed to schedule macOS window chrome: {error}");
        }
    }
}

/// The running product's name ("Pragma" / "Pragma Dev").
///
/// The title is set at runtime rather than per-config because the dev overlay
/// only differs from the shipped config in its product name, and duplicating the
/// whole window array to carry that one string is what would silently
/// re-introduce the shipped config's other values on top of the platform ones.
#[must_use]
pub fn product_name(window: &WebviewWindow) -> String {
    window.package_info().name.clone()
}

fn apply_title(window: &WebviewWindow, name: &str) {
    if let Err(error) = window.set_title(name) {
        log::warn!("failed to set window title: {error}");
    }
}

#[cfg(target_os = "macos")]
fn apply_macos(window: &WebviewWindow) {
    use tauri_plugin_decorum::WebviewWindowExt;
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    if let Err(error) = apply_vibrancy(
        window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::Active),
        None,
    ) {
        log::warn!("failed to apply macOS vibrancy: {error}");
    }

    // Center the traffic lights within the custom titlebar. decorum re-applies
    // this inset across resize / fullscreen transitions for us.
    #[allow(clippy::cast_precision_loss)]
    let inset = CONSTANTS.window.traffic_light_inset as f32;
    if let Err(error) = window.set_traffic_lights_inset(inset, inset) {
        log::warn!("failed to inset macOS traffic lights: {error}");
    }
}
