/**
 * Whether this webview is a computer-use cursor overlay, from its URL fragment.
 *
 * `src-tauri/src/computer.rs` opens the same bundle in one transparent,
 * click-through window per display and says so in the fragment:
 * `computer-overlay=<displayId>&x=<x>&y=<y>`, where the origin is the
 * display's top-left in screen points.
 */
export interface ComputerOverlayRoute {
  kind: "overlay";
  displayId: string;
  origin: { x: number; y: number };
}

/** Parses a fragment (with or without its leading `#`). */
export function parseComputerWindowRoute(hash: string): ComputerOverlayRoute | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const overlay = params.get("computer-overlay");
  if (!overlay) return null;

  return {
    kind: "overlay",
    displayId: overlay,
    origin: { x: finiteOrigin(params.get("x")), y: finiteOrigin(params.get("y")) },
  };
}

function finiteOrigin(raw: string | null): number {
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? value : 0;
}
