//! Native window chrome: macOS vibrancy + inset traffic lights.
//!
//! Pragma uses a custom (frontend-painted) titlebar. On macOS we make the window
//! transparent and drop an `NSVisualEffectView` behind it ([`window-vibrancy`])
//! so the translucent project rail reveals the desktop blur, then nudge the
//! traffic-light buttons down so they center within the taller custom titlebar
//! ([`tauri-plugin-decorum`]). On other platforms this is a no-op — the window
//! stays opaque and uses its standard decorations.

use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
use pragma_constants::CONSTANTS;

/// Applies native window chrome to `window`. Failures are logged, never fatal:
/// a missing visual effect just falls back to the opaque charcoal surface.
pub fn apply(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    apply_macos(window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
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
