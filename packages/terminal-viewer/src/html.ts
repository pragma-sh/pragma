import { TERMINAL_RUNTIME_SCRIPT, TERMINAL_RUNTIME_STYLES } from "./generated/runtime-script";
import { terminalBackgroundColor, type TerminalViewerMode } from "./theme";

/** Id of the theme block the host rewrites in place when the theme changes. */
const THEME_STYLE_ELEMENT_ID = "pragma-terminal-theme";

/** Options for {@link buildTerminalViewerHtml}. */
export interface TerminalViewerHtmlOptions {
  /** Which color scheme the host is rendering in. */
  mode?: TerminalViewerMode;
  /**
   * Host theme overrides as CSS declarations (`--terminal-background: #09090b;`).
   * Build it with {@link terminalThemeCss}.
   */
  themeCss?: string;
  /**
   * Origin of the page embedding this document, for the web build's
   * `postMessage` targeting. The document is loaded from a string, so its own
   * origin is opaque and it cannot derive the embedder's; passing it keeps
   * renderer messages addressed rather than broadcast. A native web view has
   * its own bridge and ignores this.
   */
  parentOrigin?: string;
}

/** Colors the document reads. Anything else in the overrides is ignored. */
const THEME_TOKENS = new Set([
  "terminal-background",
  "terminal-foreground",
  "terminal-cursor",
  "terminal-selection",
]);

/**
 * Turns host theme colors into the CSS custom-property block the document takes.
 *
 * Only the four terminal tokens pass, and only as simple color literals: this
 * string is injected into a `<style>` element, so an unvalidated value would be
 * a way to write arbitrary CSS into the document.
 */
export function terminalThemeCss(overrides: Readonly<Record<string, string | undefined>>): string {
  const declarations = Object.entries(overrides)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .filter(([token, value]) => THEME_TOKENS.has(token) && isSafeColor(value))
    .map(([token, value]) => `--${token}: ${value};`)
    .join("");
  return declarations ? `:root{${declarations}}` : "";
}

/** A color literal: hex, `rgb()/rgba()`, `hsl()/hsla()`, `oklch()`, or a keyword. */
function isSafeColor(value: string): boolean {
  return /^(#[0-9a-f]{3,8}|(rgba?|hsla?|oklch|oklab|color)\([0-9a-z%.,\s/-]*\)|[a-z]+)$/i.test(
    value.trim(),
  );
}

/**
 * Builds the whole terminal document: one self-contained HTML string with
 * xterm, its stylesheet, and the bridge runtime inlined.
 *
 * Self-contained is the requirement, not a preference. A web view loading this
 * from a string has no origin to resolve relative URLs against, and a phone
 * driving a terminal over a tunnel must not wait on a second round trip before
 * it can paint a keystroke.
 */
export function buildTerminalViewerHtml(options: TerminalViewerHtmlOptions = {}): string {
  const mode = options.mode ?? "dark";
  return `<!doctype html>
<html class="${mode}" lang="en"><head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" name="viewport">
<title>Terminal</title>
<style id="${THEME_STYLE_ELEMENT_ID}">${options.themeCss ?? ""}</style>
<style>${TERMINAL_RUNTIME_STYLES}</style>
<style>${documentStyles(mode)}</style>
</head><body><div id="terminal"></div>
<script>globalThis.pragmaTerminalParentOrigin=${JSON.stringify(options.parentOrigin ?? "*")};</script>
<script>${TERMINAL_RUNTIME_SCRIPT}</script>
</body></html>`;
}

/**
 * Serializes a command for the bridge.
 *
 * A native web view injects this into the document as JavaScript source, so the
 * JSON is embedded as a string literal and parsed there rather than spliced in
 * as an expression.
 */
export function terminalCommandScript(command: unknown): string {
  return `window.pragmaTerminalCommand && window.pragmaTerminalCommand(${JSON.stringify(
    JSON.stringify(command),
  )});true;`;
}

/**
 * The document's own chrome, with the mode's background baked into the `var()`
 * fallback. The literal matters: it is what paints in the instant before xterm
 * has a canvas, and a hard-coded dark value would flash black behind a light
 * terminal.
 */
function documentStyles(mode: TerminalViewerMode): string {
  return `
:root{color-scheme:light dark}
html,body{margin:0;height:100%;background:var(--terminal-background,${terminalBackgroundColor(mode)})}
#terminal{position:absolute;inset:0;padding:8px}
.xterm .xterm-viewport{overflow-y:auto;-webkit-overflow-scrolling:touch;background-color:transparent!important}
/* Selection has to be reachable by touch: the desktop's hover affordances do
   not exist here, so long-press selection must not be suppressed. */
.xterm .xterm-screen{-webkit-user-select:text;user-select:text}
`;
}
