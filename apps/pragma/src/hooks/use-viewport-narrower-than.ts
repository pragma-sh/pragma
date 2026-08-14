import { useEffect, useState } from "react";

/**
 * Current window width in px.
 *
 * `window.innerWidth` is a plain JS property the webview updates on every
 * resize, unlike CSS viewport units, which WKWebView does not recompute on a
 * live window resize (the same reason the shell's height chain is
 * percentage-based — see `WorkspaceShell`). `documentElement.clientWidth` is
 * the fallback for the rare host that reports 0.
 */
function windowWidth(): number {
  return window.innerWidth || document.documentElement.clientWidth;
}

/** Whether the window is narrower than `breakpoint` px, kept live as it resizes. */
export function useViewportNarrowerThan(breakpoint: number): boolean {
  const [narrow, setNarrow] = useState(() => windowWidth() < breakpoint);

  useEffect(() => {
    const update = () => setNarrow(windowWidth() < breakpoint);
    update();
    window.addEventListener("resize", update);
    // A `ResizeObserver` as well as the event: a Tauri window can be resized by
    // the compositor without a `resize` event landing in the page, and the
    // observer reports the resolved layout box either way.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => update());
    observer?.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [breakpoint]);

  return narrow;
}
