import type { BrowserBounds } from "@/lib/tauri";

/**
 * Geometry + defaults for native browser webviews.
 *
 * Browser tabs render a native child webview that floats *on top of* a React
 * placeholder `<div>` (the page content can't live in React — it's a separate
 * Tauri webview). These pure helpers translate the placeholder's DOM rect into
 * the coordinate spaces the Rust side expects, and are unit-tested in isolation.
 */

/** Default page a freshly-created browser tab opens to. */
export const BROWSER_START_URL = "https://pragma-app.sh";

/** Time allowed for a native page navigation before showing recovery UI. */
export const BROWSER_LOAD_TIMEOUT_MS = 15_000;

/**
 * Logical (CSS-pixel) bounds relative to the window's top-left — the space Tauri
 * uses to position an embedded child webview. The main React webview fills the
 * window content, so `getBoundingClientRect` is already in this space.
 */
export function rectToBounds(rect: DOMRect): BrowserBounds {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/**
 * Physical screen-pixel bounds of the placeholder, for screen-capture cropping.
 * Combines the in-window rect with the window's on-screen offset and scales by
 * the device pixel ratio so it lines up with monitor pixels.
 */
export function screenshotBounds(
  rect: DOMRect,
  screenX: number,
  screenY: number,
  devicePixelRatio: number,
): BrowserBounds {
  return {
    x: (rect.left + screenX) * devicePixelRatio,
    y: (rect.top + screenY) * devicePixelRatio,
    width: rect.width * devicePixelRatio,
    height: rect.height * devicePixelRatio,
  };
}
