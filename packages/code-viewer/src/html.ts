import { CODE_RUNTIME_SCRIPT } from "./generated/runtime-script";
import { CODE_CONTENT_ELEMENT_ID, type CodeViewerContent } from "./messages";
import { CODE_VIEWER_FONT_FAMILY, codeViewerBackground, type CodeViewerMode } from "./palette";

/** Options for {@link buildCodeViewerHtml}. */
export interface CodeViewerHtmlOptions {
  /** The file or diff to show. */
  content: CodeViewerContent;
  /** Which color scheme the host is rendering in. */
  mode?: CodeViewerMode;
  /** Soft-wrap long lines instead of scrolling sideways. */
  wrap?: boolean;
  /**
   * Origin of the page embedding this document, for the web build's
   * `postMessage` targeting. A native web view has its own bridge and ignores it.
   */
  parentOrigin?: string;
}

/**
 * Builds the whole viewer: one self-contained HTML string with CodeMirror, the
 * grammars, and the content inlined.
 *
 * Self-contained because a web view loading a string has no origin to resolve
 * URLs against, and a phone on a tunnel should not wait on a second round trip.
 * The content rides in a JSON `<script>` block — inert data, never evaluated —
 * with `<` escaped so no file can close the element early: source files
 * routinely contain `</script>`.
 */
export function buildCodeViewerHtml(options: CodeViewerHtmlOptions): string {
  const mode = options.mode ?? "dark";
  const config = { content: options.content, mode, wrap: options.wrap ?? false };
  return `<!doctype html>
<html class="${mode}" lang="en"><head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" name="viewport">
<title>Code</title>
<style>${documentStyles(mode)}</style>
</head><body><div id="code"></div>
<script id="${CODE_CONTENT_ELEMENT_ID}" type="application/json">${inertJson(config)}</script>
<script>globalThis.pragmaCodeParentOrigin=${inertJson(options.parentOrigin ?? "*")};</script>
<script>${CODE_RUNTIME_SCRIPT}</script>
</body></html>`;
}

/**
 * JSON safe to place inside a `<script>` element: `<` becomes `<`, which
 * `JSON.parse` reads back identically, and the two line separators JavaScript
 * once treated as newlines are escaped too.
 */
function inertJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/** The document's own chrome; the mode's background is baked in to avoid a flash. */
function documentStyles(mode: CodeViewerMode): string {
  return `
:root{color-scheme:${mode}}
html,body{margin:0;height:100%;background:${codeViewerBackground(mode)}}
#code{position:absolute;inset:0}
#code .cm-editor{height:100%}
#code .cm-scroller{-webkit-overflow-scrolling:touch;font-family:${CODE_VIEWER_FONT_FAMILY}}
.pragma-code-empty{font:13px -apple-system,system-ui,sans-serif;padding:16px;opacity:.6;color:${mode === "dark" ? "#cbd5e1" : "#1f2937"}}
`;
}
