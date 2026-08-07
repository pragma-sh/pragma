import { VIEWER_RUNTIME_SCRIPT } from "./generated/runtime-script";
import type { ScratchpadComment } from "./messages";

/** Id of the theme block the host rewrites in place when the theme changes. */
const THEME_STYLE_ELEMENT_ID = "pragma-scratchpad-theme";

/** Options for {@link buildScratchpadViewerHtml}. */
export interface ScratchpadViewerHtmlOptions {
  /** The scratchpad's MDX source, frontmatter included. */
  source: string;
  /** Comments to highlight on first paint. */
  comments?: readonly ScratchpadComment[];
  /** Which color scheme the host is rendering in. */
  mode?: "light" | "dark";
  /**
   * Host theme overrides as CSS declarations (`--card: oklch(...);`).
   *
   * Only overrides belong here. Every `@pragma/scratchpad` rule already carries
   * a literal fallback after its `var()`, which is what a scratchpad rendered
   * outside the desktop uses — restating those defaults here would fork the
   * palette. Build this with {@link scratchpadThemeCss}.
   */
  themeCss?: string;
}

/** Turns host theme overrides into the CSS custom-property block the document takes. */
export function scratchpadThemeCss(
  overrides: Readonly<Record<string, string | undefined>>,
): string {
  const declarations = Object.entries(overrides)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .filter(([token, value]) => isSafeToken(token) && isSafeValue(value))
    .map(([token, value]) => `--${token}: ${value};`)
    .join("");
  return declarations ? `:root{${declarations}}` : "";
}

/**
 * Builds the whole viewer document: one self-contained HTML string with the
 * runtime, the document source, and the comment layer inlined.
 *
 * Self-contained is the requirement, not a preference — a web view loading this
 * from a string has no origin to resolve relative URLs against, and a phone
 * viewing a scratchpad over a tunnel should not need a second round trip to
 * paint. Nothing here is fetched.
 */
export function buildScratchpadViewerHtml(options: ScratchpadViewerHtmlOptions): string {
  const mode = options.mode ?? "light";
  const bootstrap = [
    RANDOM_UUID_POLYFILL,
    `globalThis.pragmaScratchpadSource=${jsonScriptLiteral(options.source)};`,
    `globalThis.pragmaScratchpadComments=${jsonScriptLiteral(options.comments ?? [])};`,
  ].join("");
  return `<!doctype html>
<html class="${mode}" lang="en"><head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" name="viewport">
<title>Scratchpad</title>
<style id="${THEME_STYLE_ELEMENT_ID}">${options.themeCss ?? ""}</style>
<style>${VIEWER_STYLES}</style>
</head><body>
<div id="root"></div>
<script>${bootstrap}</script>
<script>${VIEWER_RUNTIME_SCRIPT}</script>
</body></html>`;
}

/**
 * Serializes a value for embedding inside a `<script>` element.
 *
 * `</script` inside a string literal ends the element no matter where it
 * appears, and a scratchpad is free to contain that text; `<!--` opens an HTML
 * comment in the same way. Escaping both angle brackets closes each hole.
 */
function jsonScriptLiteral(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/**
 * Gives the page a `crypto.randomUUID`.
 *
 * A document loaded from an HTML string has no origin, so it is not a secure
 * context, and `crypto.randomUUID` — unlike `crypto.getRandomValues` — is gated
 * on one. Agent-authored scratchpads reach for it freely (it is the obvious way
 * to key a list), and on a phone that call throws where it works on the
 * desktop. Defined here rather than in the runtime because it must exist before
 * any bundled module's top-level code runs.
 */
const RANDOM_UUID_POLYFILL = `(()=>{try{
if(typeof crypto==="undefined"||typeof crypto.randomUUID==="function")return;
Object.defineProperty(crypto,"randomUUID",{configurable:true,writable:true,value:()=>{
const b=crypto.getRandomValues(new Uint8Array(16));
b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
const h=[...b].map((x)=>x.toString(16).padStart(2,"0")).join("");
return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20);
}});}catch{}})();`;

/** Rejects token names that could break out of the declaration block. */
function isSafeToken(token: string): boolean {
  return /^[a-z][\w-]*$/i.test(token);
}

/** Rejects values carrying a declaration or block terminator. */
function isSafeValue(value: string): boolean {
  return value.length <= 200 && !/[;{}<>]/.test(value);
}

/**
 * The document's own chrome: page frame, and the comment picker's four block
 * states (idle, previewing under a long press, selected, already commented).
 * Component styling comes from `@pragma/scratchpad`'s injected stylesheet.
 */
const VIEWER_STYLES = `
*{box-sizing:border-box}
html{color-scheme:light dark;-webkit-text-size-adjust:100%}
html.dark{color-scheme:dark}
body{margin:0;padding:16px 16px 48px;background:var(--background,#fff);color:var(--foreground,#0a0a0b);
  font-family:var(--font-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif);
  font-size:16px;line-height:1.65;-webkit-tap-highlight-color:transparent}
#root{max-width:48rem;margin:0 auto}
#root>*{scroll-margin-top:16px}
img,video,canvas,svg{max-width:100%;height:auto}
pre{overflow-x:auto;padding:12px;border-radius:var(--radius-md,8px);background:var(--muted,#f4f4f5)}
table{display:block;overflow-x:auto;border-collapse:collapse}
th,td{border:1px solid var(--border,#e4e4e7);padding:6px 10px;text-align:left}
blockquote{margin:1em 0;padding-left:12px;border-left:3px solid var(--border,#e4e4e7);color:var(--muted-foreground,#71717a)}
.pragma-viewer-error{margin:1rem 0;padding:1rem;border:1px solid var(--destructive,#dc2626);border-radius:var(--radius-lg,12px);
  color:var(--destructive,#dc2626);background:color-mix(in oklab,var(--destructive,#dc2626) 12%,transparent);font-size:.875rem}
.pragma-viewer-error pre{margin:.5rem 0 0;white-space:pre-wrap;background:transparent;padding:0}
/* Comment mode: blocks become targets, and text selection stops competing with
   the long press that previews one. */
.pragma-viewer-picking body{user-select:none;-webkit-user-select:none}
.pragma-viewer-picking .pragma-viewer-block{border-radius:var(--radius-md,8px);transition:background-color .12s ease,box-shadow .12s ease}
.pragma-viewer-commented{background:color-mix(in oklab,var(--warning,#f59e0b) 22%,transparent);
  box-shadow:inset 0 -2px 0 0 color-mix(in oklab,var(--warning,#f59e0b) 70%,transparent)}
.pragma-viewer-previewing{background:color-mix(in oklab,var(--primary,#3b82f6) 16%,transparent);
  box-shadow:0 0 0 2px color-mix(in oklab,var(--primary,#3b82f6) 60%,transparent)}
.pragma-viewer-selected{background:color-mix(in oklab,var(--primary,#3b82f6) 22%,transparent);
  box-shadow:0 0 0 2px var(--primary,#3b82f6)}
`;
