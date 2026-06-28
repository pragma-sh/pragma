import type { MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Mouse-down handler that drags (or, on double-click, zooms) the native window.
 *
 * Replaces Tauri's `data-tauri-drag-region` attribute, whose built-in wry
 * handler is unreliable on macOS once the window is `transparent` and backed by
 * an `NSVisualEffectView` (vibrancy) — the native hit-test never starts the
 * drag. Calling `startDragging()` from a real React handler is deterministic.
 *
 * Only a primary-button press landing directly on the handle (not on an
 * interactive child) drags, mirroring the original attribute's semantics so
 * buttons inside the titlebar stay clickable.
 */
export function startWindowDrag(event: MouseEvent<HTMLElement>): void {
  if (event.button !== 0 || event.target !== event.currentTarget) return;
  const appWindow = getCurrentWindow();
  if (event.detail === 2) {
    void appWindow.toggleMaximize();
    return;
  }
  void appWindow.startDragging();
}
