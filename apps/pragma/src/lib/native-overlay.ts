import { useEffect, useSyncExternalStore } from "react";

/**
 * Ref-counted signal for "an HTML overlay that must float above the native
 * browser webviews is currently open" (dropdowns, popovers, …).
 *
 * Native `BrowserView` webviews paint ABOVE all HTML, so a portaled dropdown or
 * popover would otherwise be covered/clipped by the page. While any such overlay
 * is open we hide the native browser overlays so the HTML on top is visible.
 * This mirrors the drag-suppression need but is generalized; it's a module-level
 * store (not a context) because overlays render into portals anywhere in the tree.
 */
let count = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Register one open overlay. Returns a release function that is idempotent (safe
 * to call once, even if the owning component unmounts while still "open").
 */
export function acquireNativeOverlaySuppression(): () => void {
  count += 1;
  emit();
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    count -= 1;
    emit();
  };
}

/** Whether native browser overlays should be suppressed right now. */
export function isNativeOverlaySuppressed(): boolean {
  return count > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe a component to the suppression signal. */
export function useNativeOverlaySuppressed(): boolean {
  return useSyncExternalStore(subscribe, isNativeOverlaySuppressed, isNativeOverlaySuppressed);
}

/**
 * Hold a suppression registration for as long as `active` is true. Releasing on
 * cleanup means an overlay that unmounts while open still decrements the count.
 */
export function useSuppressNativeOverlayWhile(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    return acquireNativeOverlaySuppression();
  }, [active]);
}
