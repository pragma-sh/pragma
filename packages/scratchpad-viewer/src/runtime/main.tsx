/**
 * The scratchpad viewer's in-page runtime, bundled into one script string and
 * inlined into the document `buildScratchpadViewerHtml` produces.
 *
 * It does three things: evaluate the scratchpad's MDX at run time with the real
 * `@pragma/scratchpad` components, expose the same `globalThis.pragmaScratchpad`
 * bridge those components expect (relayed to the native host instead of a parent
 * frame), and run the touch comment picker — tap to select a block, press and
 * hold to preview where a comment would land before committing it.
 *
 * Everything here runs inside the web view, so it may use DOM APIs freely but
 * must never assume a bundler, a network, or a parent window.
 */
import { evaluate } from "@mdx-js/mdx";
import * as Scratchpad from "@pragma/scratchpad";
import type { ScratchpadBridge } from "@pragma/scratchpad";
import * as ScratchpadPrimitives from "@pragma/scratchpad/ui/primitives";
import * as ScratchpadUi from "@pragma/scratchpad/ui";
import * as React from "react";
import { Component, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import remarkGfm from "remark-gfm";

import { prepareMdxSource } from "../mdx-source";
import type {
  ScratchpadBlock,
  ScratchpadComment,
  ScratchpadViewerCommand,
  ScratchpadViewerMessage,
} from "../messages";

/** How long a touch must rest on a block before it previews as a target. */
const LONG_PRESS_MS = 350;
/** Movement past this many CSS pixels is a scroll, not a press. */
const MOVE_TOLERANCE_PX = 12;
/** Longest quote carried back to the host for a comment. */
const MAX_QUOTE_LENGTH = 240;

declare global {
  var pragmaScratchpadSource: string;
  var pragmaScratchpadComments: ScratchpadComment[];
  /**
   * The bridge `@pragma/scratchpad` components reach for. Declared here because
   * the package ships it as an ambient global only in its source, not its types.
   */
  var pragmaScratchpad: ScratchpadBridge | undefined;
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    /** Entry point the native host calls with a serialized command. */
    pragmaScratchpadViewer?: { receive(message: string): void };
  }
}

function post(message: ScratchpadViewerMessage): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));
}

/* ------------------------------------------------------------------ bridge */

const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (e: Error) => void }
>();
const progressListeners = new Map<string, (entries: unknown[]) => void>();

/**
 * A random id that works in this page.
 *
 * `crypto.randomUUID` is gated on a secure context, and a web view rendering an
 * HTML string has no origin — so on iOS it is simply missing, and every bridge
 * call threw before it left the page. `crypto.getRandomValues` carries no such
 * gate; the timestamp path is the last resort for a runtime with neither.
 */
function randomId(): string {
  const values = globalThis.crypto?.getRandomValues?.(new Uint8Array(16));
  if (values) return [...values].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function requestHost<T>(build: (requestId: string) => ScratchpadViewerMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const requestId = randomId();
    pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
    post(build(requestId));
  });
}

const bridge: ScratchpadBridge = {
  promptAgent: (text) => requestHost((requestId) => ({ type: "promptAgent", requestId, text })),
  requestAgentAttachment: () =>
    requestHost((requestId) => ({ type: "requestAgentAttachment", requestId })),
  subscribeAgentProgress: (tabIds, listener) => {
    const requestId = randomId();
    progressListeners.set(requestId, (entries) =>
      listener(entries as Parameters<typeof listener>[0]),
    );
    post({ type: "subscribeAgentProgress", requestId, tabIds: [...tabIds] });
    return () => {
      progressListeners.delete(requestId);
      post({ type: "unsubscribeAgentProgress", requestId });
    };
  },
};
globalThis.pragmaScratchpad = bridge;

/** Applies the host's theme override block without reloading the document. */
function applyTheme(css: string, mode: "light" | "dark"): void {
  const style = document.getElementById("pragma-scratchpad-theme");
  if (style) style.textContent = css;
  document.documentElement.className = mode;
}

/** Settles the promise a bridge call is waiting on. */
function settleRequest(requestId: string, value: unknown, error: string | undefined): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  if (error) entry.reject(new Error(error));
  else entry.resolve(value);
}

/** Routes one host command to the piece of the page that owns it. */
const commandHandlers: {
  [K in ScratchpadViewerCommand["type"]]: (
    command: Extract<ScratchpadViewerCommand, { type: K }>,
  ) => void;
} = {
  comments: (command) => applyComments(command.comments),
  commentMode: (command) => setCommentMode(command.active),
  clearSelection: () => setSelectedBlock(null),
  theme: (command) => applyTheme(command.css, command.mode),
  response: (command) => settleRequest(command.requestId, command.value, command.error),
  progress: (command) => progressListeners.get(command.requestId)?.(command.entries),
};

function handleCommand(command: ScratchpadViewerCommand): void {
  const handler = commandHandlers[command.type] as (value: ScratchpadViewerCommand) => void;
  handler(command);
}

window.pragmaScratchpadViewer = {
  receive(message) {
    try {
      handleCommand(JSON.parse(message) as ScratchpadViewerCommand);
    } catch (cause) {
      post({ type: "error", message: `Bad viewer command: ${String(cause)}` });
    }
  },
};

/* ------------------------------------------------------------- comment layer */

let commentMode = false;
let selectedIndex: number | null = null;
let previewIndex: number | null = null;

/** The document's top-level rendered blocks, re-read after every render. */
function blocks(): HTMLElement[] {
  const root = document.getElementById("root");
  if (!root) return [];
  return [...root.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
}

function blockAt(index: number): ScratchpadBlock | null {
  const element = blocks()[index];
  if (!element) return null;
  return { index, quote: quoteOf(element) };
}

function quoteOf(element: HTMLElement): string {
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > MAX_QUOTE_LENGTH ? `${text.slice(0, MAX_QUOTE_LENGTH - 1)}…` : text;
}

/** Indexes blocks so classes and hit-testing agree on what "block 3" means. */
function indexBlocks(): void {
  blocks().forEach((element, index) => {
    element.dataset.pragmaBlock = String(index);
    element.classList.add("pragma-viewer-block");
  });
  applyComments(globalThis.pragmaScratchpadComments ?? []);
}

function applyComments(comments: ScratchpadComment[]): void {
  globalThis.pragmaScratchpadComments = comments;
  const commented = new Set(
    comments
      .filter((comment) => comment.resolvedAt === null && typeof comment.blockIndex === "number")
      .map((comment) => comment.blockIndex),
  );
  blocks().forEach((element, index) => {
    element.classList.toggle("pragma-viewer-commented", commented.has(index));
  });
}

function setCommentMode(active: boolean): void {
  commentMode = active;
  document.documentElement.classList.toggle("pragma-viewer-picking", active);
  if (!active) {
    setSelectedBlock(null);
    setPreviewBlock(null);
  }
}

function setSelectedBlock(index: number | null): void {
  selectedIndex = index;
  blocks().forEach((element, position) => {
    element.classList.toggle("pragma-viewer-selected", position === index);
  });
}

function setPreviewBlock(index: number | null): void {
  if (previewIndex === index) return;
  previewIndex = index;
  blocks().forEach((element, position) => {
    element.classList.toggle("pragma-viewer-previewing", position === index);
  });
  post({ type: "preview", block: index === null ? null : blockAt(index) });
}

/** The block index under a touch point, or null when the touch missed one. */
function blockIndexAtPoint(x: number, y: number): number | null {
  const element = document.elementFromPoint(x, y);
  if (!(element instanceof HTMLElement)) return null;
  const block = element.closest<HTMLElement>("[data-pragma-block]");
  const index = block?.dataset.pragmaBlock;
  return index === undefined ? null : Number(index);
}

interface PressState {
  startX: number;
  startY: number;
  index: number | null;
  timer: number | null;
  previewing: boolean;
}

let press: PressState | null = null;

function cancelPress(): void {
  const timer = press?.timer;
  if (typeof timer === "number") clearTimeout(timer);
  press = null;
  setPreviewBlock(null);
}

/** Selects a block and tells the host, which opens its comment composer. */
function commitSelection(index: number | null): void {
  const block = index === null ? null : blockAt(index);
  if (!block) return;
  setSelectedBlock(block.index);
  post({ type: "select", block });
}

/** True once the finger has travelled far enough to be a scroll, not a press. */
function movedBeyondTolerance(touch: Touch, from: PressState): boolean {
  return (
    Math.abs(touch.clientX - from.startX) > MOVE_TOLERANCE_PX ||
    Math.abs(touch.clientY - from.startY) > MOVE_TOLERANCE_PX
  );
}

function onTouchStart(event: TouchEvent): void {
  if (!commentMode) return;
  const touch = event.touches[0];
  if (!touch) return;
  const index = blockIndexAtPoint(touch.clientX, touch.clientY);
  press = {
    startX: touch.clientX,
    startY: touch.clientY,
    index,
    previewing: false,
    timer: window.setTimeout(() => {
      if (!press) return;
      press.previewing = true;
      setPreviewBlock(press.index);
    }, LONG_PRESS_MS),
  };
}

/**
 * Before the long press fires, movement means the user is scrolling, so the
 * press is abandoned. After it fires the finger drags the target instead, like
 * a magnifier, and the page must stop scrolling under it.
 */
function onTouchMove(event: TouchEvent): void {
  const moving = movingPress(event);
  if (!moving) return;
  if (moving.current.previewing) dragPreview(event, moving.touch, moving.current);
  else abandonIfScrolled(moving.touch, moving.current);
}

/** The moving touch paired with the live press, when there is both. */
function movingPress(event: TouchEvent): { touch: Touch; current: PressState } | null {
  const touch = event.touches[0];
  return press && touch ? { touch, current: press } : null;
}

/** A finger that travelled before the long press fired was scrolling. */
function abandonIfScrolled(touch: Touch, current: PressState): void {
  if (movedBeyondTolerance(touch, current)) cancelPress();
}

/** Moves the previewed target under the finger, taking the scroll gesture over. */
function dragPreview(event: TouchEvent, touch: Touch, current: PressState): void {
  event.preventDefault();
  current.index = blockIndexAtPoint(touch.clientX, touch.clientY);
  setPreviewBlock(current.index);
}

function onTouchEnd(): void {
  const current = press;
  if (!current) return;
  cancelPress();
  // A tap selects immediately; a long press commits whatever it was previewing.
  if (commentMode || current.previewing) commitSelection(current.index);
}

document.addEventListener("touchstart", onTouchStart, { passive: true });
document.addEventListener("touchmove", onTouchMove, { passive: false });
document.addEventListener("touchend", onTouchEnd);
document.addEventListener("touchcancel", cancelPress);
// Desktop web views (and the package's own tests) have no touch events.
document.addEventListener("click", (event) => {
  if (!commentMode || press) return;
  commitSelection(blockIndexAtPoint(event.clientX, event.clientY));
});

/* ------------------------------------------------------------------ render */

/** Reports a component that threw instead of blanking the whole document. */
class ScratchpadBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { message: null };
  }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown): void {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }

  render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="pragma-viewer-error">
        <strong>This component could not render.</strong>
        <pre>{this.state.message}</pre>
      </div>
    );
  }
}

/**
 * Components an MDX document may reference without importing.
 *
 * A scratchpad's `import` statements are stripped before evaluation (there is no
 * module resolver in a web view), so every capitalized tag resolves from here.
 * A component the library does not ship raises MDX's own "Expected component X
 * to be defined" error, which the boundary above renders in place.
 */
function componentScope(): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  for (const source of [Scratchpad, ScratchpadUi, ScratchpadPrimitives]) {
    for (const [name, value] of Object.entries(source)) {
      if (/^[A-Z]/.test(name)) scope[name] = value;
    }
  }
  return scope;
}

/**
 * Window properties that must keep their meaning even if a module happens to
 * export the same name — overwriting `location` or `top` breaks the page.
 */
const RESERVED_GLOBALS = new Set([
  "close",
  "document",
  "history",
  "length",
  "location",
  "name",
  "navigator",
  "open",
  "opener",
  "parent",
  "print",
  "self",
  "status",
  "top",
  "window",
]);

/**
 * Publishes the modules a scratchpad imports as page globals.
 *
 * `components` only covers capitalized tags MDX renders. It does **not** cover
 * an identifier the document's own code calls — and a scratchpad that defines a
 * nested component is exactly that case:
 *
 * ```mdx
 * import { useState } from "react";
 * export function Counter() { const [n, set] = useState(0); ... }
 * ```
 *
 * The import is stripped, MDX compiles the body to a function, and `useState`
 * is then a free variable resolved against the global scope — which is why a
 * document like that used to die with "Can't find variable: useState". Since
 * that scope is the only one the compiled body can see, the imports' exports go
 * there: React (hooks included) and every `@pragma/scratchpad` entry point.
 */
function installGlobalScope(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.React = React;
  for (const source of [React, Scratchpad, ScratchpadUi, ScratchpadPrimitives]) {
    publishExports(source as Record<string, unknown>, globals);
  }
}

/** Copies a module's named exports onto the global object. */
function publishExports(source: Record<string, unknown>, globals: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(source)) {
    if (name !== "default" && !RESERVED_GLOBALS.has(name)) globals[name] = value;
  }
}

async function render(): Promise<void> {
  const container = document.getElementById("root");
  if (!container) return;
  installGlobalScope();
  try {
    const module = await evaluate(prepareMdxSource(globalThis.pragmaScratchpadSource), {
      ...jsxRuntime,
      remarkPlugins: [remarkGfm],
      development: false,
    });
    const Content = module.default as (props: { components: Record<string, unknown> }) => ReactNode;
    createRoot(container).render(
      <StrictMode>
        <ScratchpadBoundary>
          <Content components={componentScope()} />
        </ScratchpadBoundary>
      </StrictMode>,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    container.innerHTML = "";
    const error = document.createElement("div");
    error.className = "pragma-viewer-error";
    error.textContent = `This scratchpad could not be rendered: ${message}`;
    container.append(error);
    post({ type: "error", message });
  }
  // The tree is committed asynchronously; index once the DOM settles.
  requestAnimationFrame(() => {
    indexBlocks();
    post({ type: "ready", height: documentHeight() });
  });
}

function documentHeight(): number {
  return Math.ceil(document.documentElement.scrollHeight);
}

let lastHeight = 0;
new ResizeObserver(() => {
  const height = documentHeight();
  if (height === lastHeight) return;
  lastHeight = height;
  indexBlocks();
  if (selectedIndex !== null) setSelectedBlock(selectedIndex);
  post({ type: "height", height });
}).observe(document.documentElement);

addEventListener("error", (event) => post({ type: "error", message: event.message }));
addEventListener("unhandledrejection", (event) =>
  post({ type: "error", message: String(event.reason) }),
);

void render();
