/**
 * The terminal document's runtime: xterm.js wired to the host bridge.
 *
 * This is bundled into a single inline script by `scripts/build.ts`, because
 * the document is loaded from a string and has no origin to resolve anything
 * against — no CDN, no module loader, no second round trip over a tunnel.
 */
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";

import {
  isTerminalViewerCommand,
  type TerminalViewerCommand,
  type TerminalViewerMessage,
} from "../messages";
import {
  TERMINAL_FALLBACK_COLORS,
  TERMINAL_FALLBACK_SELECTION,
  TERMINAL_LIGHT_ANSI,
  TERMINAL_MINIMUM_CONTRAST,
} from "../theme";
import { bindTouchScroll } from "./touch-scroll";

declare global {
  interface Window {
    /** React Native's web-view bridge, present only inside a native client. */
    ReactNativeWebView?: { postMessage: (message: string) => void };
    /** Applies one command; the host calls this directly on the web. */
    pragmaTerminalCommand?: (raw: string) => void;
    /** Origin the embedding page is served from, for `postMessage` targeting. */
    pragmaTerminalParentOrigin?: string;
  }
}

const encoder = new TextEncoder();

const terminal = new Terminal({
  allowProposedApi: true,
  convertEol: false,
  cursorBlink: true,
  // A phone renders far fewer columns than a desktop, so a line wraps many more
  // times; the same number of *lines* is much less history than it sounds.
  scrollback: 5_000,
  fontSize: 13,
  fontFamily:
    "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  theme: { background: "transparent" },
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
// Links are never opened by the renderer itself: the host decides, and only on
// a real activation. Terminal output is untrusted text, and a document that
// navigated on its own would let a program a user is merely *watching* move the
// view somewhere else.
terminal.loadAddon(
  new WebLinksAddon((event, url) => {
    event.preventDefault();
    send({ type: "link", url });
  }),
);

const root = document.getElementById("terminal");
if (root) {
  terminal.open(root);
  bindTouchScroll(root, {
    lineHeight: () =>
      (terminal.element?.querySelector(".xterm-screen")?.clientHeight ?? 0) / terminal.rows,
    scrollLines: (lines) => terminal.scrollLines(lines),
  });
}

function send(message: TerminalViewerMessage): void {
  const raw = JSON.stringify(message);
  if (window.ReactNativeWebView) {
    // Not `window.postMessage`: React Native's bridge takes the message alone
    // and rejects a second argument.
    // oxlint-disable-next-line require-post-message-target-origin
    window.ReactNativeWebView.postMessage(raw);
    return;
  }
  // The web build embeds this in a sandboxed iframe, which talks to its parent.
  // The document itself is loaded from a string, so its own origin is opaque and
  // cannot name the parent's: the embedder passes that in, and only messages
  // addressed to it are delivered.
  window.parent?.postMessage(raw, window.pragmaTerminalParentOrigin ?? "*");
}

terminal.onData((data) => send({ type: "input", dataBase64: encodeBase64(encoder.encode(data)) }));
// `onBinary` carries bytes the keyboard produced that are not valid UTF-16 text
// — losing them would silently drop input rather than misrender it.
terminal.onBinary((data) => send({ type: "input", dataBase64: encodeBase64(latin1Bytes(data)) }));
terminal.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
terminal.onScroll(() =>
  send({ type: "scroll", atBottom: terminal.buffer.active.viewportY >= bufferBottom() }),
);

function bufferBottom(): number {
  return terminal.buffer.active.baseY;
}

type CommandOf<T extends TerminalViewerCommand["type"]> = Extract<
  TerminalViewerCommand,
  { type: T }
>;

/** What each host command does to the terminal; one entry per command type. */
const COMMAND_HANDLERS: { [T in TerminalViewerCommand["type"]]: (command: CommandOf<T>) => void } =
  {
    write: ({ dataBase64 }) => {
      const bytes = decodeBase64(dataBase64);
      // The acknowledgement fires when the parser has consumed the bytes, not
      // when they were queued: that is what makes it usable as backpressure.
      terminal.write(bytes, () => send({ type: "written", bytes: bytes.length }));
    },
    reset: () => {
      terminal.reset();
      terminal.clear();
    },
    fit: () => fitAddon.fit(),
    focus: () => terminal.focus(),
    scrollToBottom: () => terminal.scrollToBottom(),
    theme: ({ css, mode }) => applyTheme(css, mode),
    paste: ({ text }) => terminal.paste(text),
    exit: () => {
      terminal.options.cursorBlink = false;
      terminal.options.disableStdin = true;
    },
  };

/** Applies one host command. Unknown shapes are dropped, never guessed at. */
function apply(raw: string): void {
  const parsed = parseJson(raw);
  if (!isTerminalViewerCommand(parsed)) return;
  const handler = COMMAND_HANDLERS[parsed.type] as (command: TerminalViewerCommand) => void;
  handler(parsed);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Repaints the document from host theme overrides.
 *
 * xterm reads its colors once, from options, so the palette is pushed into it
 * rather than left to CSS — a `var()` in a stylesheet never reaches the canvas.
 */
function applyTheme(css: string, mode: "light" | "dark"): void {
  const style = document.getElementById("pragma-terminal-theme");
  if (style) style.textContent = css;
  document.documentElement.className = mode;
  const computed = getComputedStyle(document.documentElement);
  const read = (token: string, fallback: string): string =>
    computed.getPropertyValue(token).trim() || fallback;
  const fallback = TERMINAL_FALLBACK_COLORS[mode];
  const foreground = read("--terminal-foreground", fallback.foreground);
  terminal.options.theme = {
    ...(mode === "light" ? TERMINAL_LIGHT_ANSI : {}),
    background: read("--terminal-background", fallback.background),
    foreground,
    cursor: read("--terminal-cursor", foreground),
    selectionBackground: read("--terminal-selection", TERMINAL_FALLBACK_SELECTION),
  };
  terminal.options.minimumContrastRatio = TERMINAL_MINIMUM_CONTRAST[mode];
}

/**
 * The palette the document was built with. A native host bakes the mode and
 * its overrides into the HTML and rebuilds the document for a new palette
 * rather than sending a `theme` command, so the canvas has to read them here —
 * otherwise xterm keeps its own default white text on a light page.
 */
function applyDocumentTheme(): void {
  const css = document.getElementById("pragma-terminal-theme")?.textContent ?? "";
  applyTheme(css, document.documentElement.classList.contains("light") ? "light" : "dark");
}

applyDocumentTheme();

window.pragmaTerminalCommand = apply;
// A native web view delivers host commands as `message` events on `document`;
// the iframe build receives them on `window`. Both land here.
document.addEventListener("message", (event) => apply(String((event as MessageEvent).data)));
window.addEventListener("message", (event) => apply(String(event.data)));

const observer = new ResizeObserver(() => fitAddon.fit());
if (root) observer.observe(root);

fitAddon.fit();
send({ type: "ready" });

/** Base64 of raw bytes, without depending on a `Buffer` that is not there. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** xterm's binary channel delivers one byte per code unit. */
function latin1Bytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}
