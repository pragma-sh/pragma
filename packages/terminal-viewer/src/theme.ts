/** Which color scheme the terminal document is rendering in. */
export type TerminalViewerMode = "light" | "dark";

/**
 * The palette the document falls back to when the host sends no override.
 *
 * One table, because three places need the same answer and disagreeing is
 * visible: the document's own `body` background, the xterm canvas theme (xterm
 * reads colors from options, never from CSS), and the native container the web
 * view is mounted in — which has to be painted *before* the document exists, or
 * the viewer flashes the platform's default white on the way in.
 */
export const TERMINAL_FALLBACK_COLORS: Record<
  TerminalViewerMode,
  { background: string; foreground: string }
> = {
  dark: { background: "#09090b", foreground: "#fafafa" },
  light: { background: "#ffffff", foreground: "#18181b" },
};

/** Selection tint, when the host overrides nothing. */
export const TERMINAL_FALLBACK_SELECTION = "rgba(120,120,140,0.35)";

/**
 * The background the terminal will paint, resolved the way the document
 * resolves it: the host's `terminal-background` override, else the mode's
 * fallback.
 *
 * A native client uses this to paint its own container the same color, so the
 * hand-off from the container to the loaded document is invisible.
 */
export function terminalBackgroundColor(
  mode: TerminalViewerMode,
  overrides: Readonly<Record<string, string | undefined>> = {},
): string {
  const override = overrides["terminal-background"];
  return typeof override === "string" && override.trim()
    ? override.trim()
    : TERMINAL_FALLBACK_COLORS[mode].background;
}
