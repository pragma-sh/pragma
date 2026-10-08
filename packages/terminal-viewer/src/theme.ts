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

/**
 * The 16 ANSI colors on a light background. xterm's defaults are tuned for a
 * dark one — its "white" and "yellow" vanish on white — so light mode swaps in
 * darker equivalents. Dark mode keeps xterm's defaults, matching the desktop.
 */
export const TERMINAL_LIGHT_ANSI = {
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
} as const;

/**
 * xterm's `minimumContrastRatio` per mode. A session is shared with the
 * desktop, whose terminal is dark, so a TUI that picks its own 24-bit colors
 * (Claude Code, Codex) picks them for a dark background; on a light one xterm
 * has to darken them to stay legible. 4.5 is WCAG AA for body text.
 */
export const TERMINAL_MINIMUM_CONTRAST: Record<TerminalViewerMode, number> = {
  dark: 1,
  light: 4.5,
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
