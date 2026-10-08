/**
 * The code document's runtime: a read-only CodeMirror view over embedded content.
 *
 * Bundled into one inline script by `scripts/build.ts` — the document is loaded
 * from a string, so there is no origin, no module loader, and no CDN to reach.
 * Every grammar in `@codemirror/language-data` is inlined with it, which is
 * what lets `loadLanguageExtension` resolve without a network.
 */
import { EditorState, type Extension, StateEffect } from "@codemirror/state";
import { EditorView, highlightActiveLine, lineNumbers } from "@codemirror/view";

import { loadLanguageExtension } from "../codemirror/language";
import { codeEditorTheme, codeSyntaxHighlighting } from "../codemirror/theme";
import { unifiedDiffDocument, unifiedDiffLines } from "../codemirror/unified-diff";
import {
  CODE_CONTENT_ELEMENT_ID,
  type CodeViewerContent,
  type CodeViewerMessage,
  isCodeViewerContent,
} from "../messages";
import { CODE_VIEWER_FONT_FAMILY, type CodeViewerMode } from "../palette";

declare global {
  interface Window {
    /** React Native's web-view bridge, present only inside a native client. */
    ReactNativeWebView?: { postMessage: (message: string) => void };
    /** Origin the embedding page is served from, for `postMessage` targeting. */
    pragmaCodeParentOrigin?: string;
  }
}

function send(message: CodeViewerMessage): void {
  const raw = JSON.stringify(message);
  if (window.ReactNativeWebView) {
    // React Native's bridge takes the message alone and rejects a second argument.
    // oxlint-disable-next-line require-post-message-target-origin
    window.ReactNativeWebView.postMessage(raw);
    return;
  }
  window.parent?.postMessage(raw, window.pragmaCodeParentOrigin ?? "*");
}

interface ViewerConfig {
  content: CodeViewerContent;
  mode: CodeViewerMode;
  wrap: boolean;
}

/** The embedded config, or null when it is missing or not readable content. */
function readConfig(): ViewerConfig | null {
  const parsed = parseEmbedded(document.getElementById(CODE_CONTENT_ELEMENT_ID)?.textContent);
  if (!isCodeViewerContent(parsed.content)) return null;
  return {
    content: parsed.content,
    mode: parsed.mode === "light" ? "light" : "dark",
    wrap: parsed.wrap === true,
  };
}

function parseEmbedded(raw: string | null | undefined): Record<string, unknown> {
  const value = parseJson(raw ?? "");
  return isRecord(value) ? value : {};
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function showEmpty(root: HTMLElement, text: string): void {
  const note = document.createElement("p");
  note.className = "pragma-code-empty";
  note.textContent = text;
  root.replaceChildren(note);
}

/** Read-only is the whole contract: no edits, no caret, nothing to save. */
function baseExtensions({ mode, wrap }: ViewerConfig): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    codeEditorTheme(mode, CODE_VIEWER_FONT_FAMILY),
    codeSyntaxHighlighting(mode),
    wrap ? EditorView.lineWrapping : [],
  ];
}

/** The editor state for the content, or null for a diff with nothing changed. */
function createState(config: ViewerConfig): EditorState | null {
  const { content, mode } = config;
  const base = baseExtensions(config);
  if (content.kind === "file") {
    return EditorState.create({
      doc: content.text,
      extensions: [...base, lineNumbers(), highlightActiveLine()],
    });
  }
  const lines = unifiedDiffLines(content.oldText, content.newText);
  if (lines.length === 0) return null;
  const diff = unifiedDiffDocument(lines, mode);
  return EditorState.create({ doc: diff.doc, extensions: [...base, ...diff.extensions] });
}

async function mount(): Promise<void> {
  const root = document.getElementById("code");
  const config = readConfig();
  if (!root || !config) {
    send({ type: "error", message: "The document carried no readable content." });
    return;
  }
  const view = render(root, config);
  if (view) await highlight(view, config.content.path);
}

/** Paints the content as plain text, or the empty note for an unchanged diff. */
function render(root: HTMLElement, config: ViewerConfig): EditorView | null {
  const state = createState(config);
  if (!state) {
    showEmpty(root, "No changes");
    send({ type: "ready", lines: 0 });
    return null;
  }
  const view = new EditorView({ state, parent: root });
  send({ type: "ready", lines: view.state.doc.lines });
  return view;
}

/**
 * The grammar arrives after the first paint: plain text is readable at once,
 * and colour follows a moment later rather than holding the whole view back.
 */
async function highlight(view: EditorView, path: string): Promise<void> {
  const language = await loadLanguageExtension(path);
  if (language) view.dispatch({ effects: StateEffect.appendConfig.of(language) });
}

void mount();
