import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type IDisposable } from "@xterm/xterm";

import { constants, type Tab } from "@pragma/constants";

import { announceSubmittedCommand } from "@/lib/agent-plugin-prompt";
import { actionForEvent, getKeybindingsConfig } from "@/lib/keybindings";
import {
  isTerminalEditingContext,
  isTextEditingContext,
  nativeEditingSequence,
} from "@/lib/native-editing";
import { isMacPlatform } from "@/lib/platform";
import {
  ptyAttach,
  ptyDetach,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  type PtyMessage,
  type PtyStream,
} from "@/lib/tauri";
import { createFileLinkProvider, getTerminalLinkHandler } from "@/lib/terminal-links";
import { hasPluginCommandForEvent } from "@/plugins/command-keybindings";

const RESIZE_DEBOUNCE_MS = 75;
/**
 * Retry budget for a PTY resize that the server rejected. A resize can race
 * the session's own spawn ("session not found") — most often on agent launch,
 * where the tab is created and fitted in the same tick as the spawn — and a
 * dropped resize would otherwise leave the PTY at the 80x24 spawn default
 * while xterm fills the pane. Retries are spaced by {@link RESIZE_RETRY_MS}.
 */
const MAX_RESIZE_RETRIES = 5;
const RESIZE_RETRY_MS = 200;
export const MAX_TERMINAL_COLS = 240;
export const MAX_TERMINAL_ROWS = 90;
/**
 * Lines xterm keeps above the viewport. Deliberately *not* the server's
 * `SCROLLBACK_LIMIT`: that one bounds retained PTY *output frames* (plus a byte
 * cap) for replay to a reattaching client, which is a different unit and a
 * different job. This is what you can actually scroll back through in a tab, so
 * it is sized against other terminals (VS Code ships 1000) rather than against
 * the replay budget.
 */
export const TERMINAL_SCROLLBACK_LINES = 5000;
/** Maximum raw output waiting behind xterm's current parser write. */
export const TERMINAL_PENDING_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
/** Largest byte slice submitted to xterm's parser in one write. */
export const TERMINAL_WRITE_CHUNK_MAX_BYTES = 64 * 1024;
/** Maximum wait for an outstanding xterm write before recreating the widget. */
export const TERMINAL_WRITE_DRAIN_TIMEOUT_MS = 1000;
/** Input retained while attach/spawn is unresolved. */
export const TERMINAL_PENDING_INPUT_MAX_BYTES = 256 * 1024;
const TERMINAL_PENDING_INPUT_MAX_MESSAGES = 1024;

// Renderer-response pacing for wheel-driven mouse reports while a TUI has mouse
// tracking enabled. Sending every report immediately builds a long PTY/render
// backlog, but rejecting wheel events in xterm's custom handler also rejects
// their pixel deltas before xterm can accumulate them. That stop-and-wait gate
// made scrolling advance only one line per full PTY round trip.
//
// Keep wheel events flowing through xterm and pace only the reports it produces.
// The first report is immediate; while its redraw drains, retain the reports that
// arrive behind it and send them as one write once the redraw lands.
//
// Retaining only the latest report capped scrolling at one line per PTY round
// trip (~30ms), which reads as a flick that barely moves. Retaining a bounded
// batch keeps the gesture's distance: a TUI drains its whole input queue before
// rendering, so N queued reports usually still cost one redraw. The bound is what
// stops macOS trackpad momentum from outrunning a TUI that does redraw per report
// — worst case is TUI_WHEEL_PENDING_REPORTS redraws per gate opening, not
// unbounded.
//
// A quiet gap identifies a deliberate new gesture and recovers from a prior
// report that produced no output at a scroll boundary.
export const MOUSE_WHEEL_GESTURE_QUIET_MS = 140;
/** Maximum time one silent or stalled TUI redraw may hold the wheel gate. */
export const MOUSE_WHEEL_RESPONSE_TIMEOUT_MS = 250;
/** Fallback when xterm parses response bytes but emits no render event. */
export const MOUSE_WHEEL_RENDER_TIMEOUT_MS = 100;
/**
 * Maximum TUI wheel reports retained behind one in-flight redraw, flushed as a
 * single write. Each report is one line of scroll — the wire format has no
 * multi-line notch — so this is the ceiling on how far one PTY round trip can
 * move a mouse-tracking TUI.
 */
export const TUI_WHEEL_PENDING_REPORTS = 4;
const LOCAL_SCROLL_SENSITIVITY = 3;
const TUI_SCROLL_SENSITIVITY = 1;
/** Maximum warm WebGL contexts retained across terminal tab switches. */
export const WEBGL_RENDERER_CACHE_SIZE = 8;
export const WEBGL_RECOVERY_MAX_ATTEMPTS = 3;
export const WEBGL_RECOVERY_DELAY_MS = 250;

export type TitleListener = (title: string) => void;
export type ExitListener = (code: number | null) => void;

/** A fuzzy find match in the terminal buffer: `row` is an absolute buffer row (scrollback included). */
export interface TerminalFuzzyMatch {
  row: number;
  from: number;
  to: number;
}

type TerminalPlatform = "mac" | "linux";

function currentTerminalPlatform(): TerminalPlatform {
  return isMacPlatform() ? "mac" : "linux";
}

function handleTerminalKeyEvent(
  manager: TerminalManager,
  tabId: string,
  event: KeyboardEvent,
): boolean {
  // xterm runs custom key handlers for both keydown and legacy keypress events.
  // WebKit can turn both Enter events into terminal input, yielding two CRs.
  if (event.type === "keypress" && event.key === "Enter") {
    return false;
  }
  const platform = currentTerminalPlatform();
  if (isFindShortcut(event, platform)) {
    event.preventDefault();
    manager.requestFind(tabId);
    return false;
  }
  if (handleSoftNewline(manager, tabId, event)) {
    return false;
  }
  if (handleNativeEditingSequence(manager, tabId, event, platform)) {
    return false;
  }
  // Let configured Pragma/plugin shortcuts bubble to the window listener even
  // when xterm owns focus.
  return (
    actionForEvent(event, getKeybindingsConfig(), platform) === null &&
    !hasPluginCommandForEvent(event)
  );
}

/** Cmd+F (mac) / Ctrl+F (linux), with no other modifiers, opens the find bar. */
function isFindShortcut(event: KeyboardEvent, platform: TerminalPlatform): boolean {
  if (event.key.toLowerCase() !== "f" || event.shiftKey || event.altKey) {
    return false;
  }
  return platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Best-effort model of the not-yet-submitted shell input line, rebuilt from
 * raw keystrokes before they're sent to the PTY. The PTY's own echo (the text
 * that actually appears on screen) comes from the remote shell, so we cannot
 * read it back locally — this local mirror is what Replace edits instead.
 * Printable inserts, backspace, and line-clearing chords are tracked;
 * anything else (arrow keys, tab-completion, other escape sequences) is left
 * as a no-op since we can't infer cursor position without shell integration.
 */
function applyLocalEcho(current: string, data: string): string {
  if (data === "\r" || data === "\n") {
    return "";
  }
  if (data === "\x7f" || data === "\b") {
    return current.slice(0, -1);
  }
  if (data === "\x15" || data === "\x03") {
    return "";
  }
  const isPlainInsert = [...data].every((char) => char.charCodeAt(0) >= 0x20 && char !== "\x7f");
  return isPlainInsert ? current + data : current;
}

function preservesLocalEchoConfidence(data: string): boolean {
  if (data === "\r" || data === "\n" || data === "\x7f" || data === "\b") {
    return true;
  }
  if (data === "\x15" || data === "\x03") {
    return true;
  }
  return [...data].every((char) => char.charCodeAt(0) >= 0x20 && char !== "\x7f");
}

const inputErrorTabs = new Set<string>();

function invokePtyInput(tabId: string, data: string): void {
  void ptyWrite(tabId, data)
    .then(() => inputErrorTabs.delete(tabId))
    .catch((error: unknown) => {
      if (!inputErrorTabs.has(tabId)) {
        inputErrorTabs.add(tabId);
        console.error(`terminal input queue rejected data for ${tabId}`, error);
      }
    });
}

function handleSoftNewline(manager: TerminalManager, tabId: string, event: KeyboardEvent): boolean {
  // Shift+Enter is a soft newline: xterm maps Enter to CR, so rewrite it to
  // ESC+CR for TUI REPLs that treat that as multiline continuation.
  if (!isPlainShiftEnter(event)) {
    return false;
  }
  event.preventDefault();
  manager.writeWhenReady(tabId, "\x1b\r");
  return true;
}

function isPlainShiftEnter(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
  );
}

function handleNativeEditingSequence(
  manager: TerminalManager,
  tabId: string,
  event: KeyboardEvent,
  platform: TerminalPlatform,
): boolean {
  // Native OS text-editing chords map to readline control characters before app
  // shortcuts, so terminal editing wins over global actions like delete-file.
  const sequence = nativeEditingSequence(event, platform);
  if (sequence === null) {
    return false;
  }
  event.preventDefault();
  manager.writeWhenReady(tabId, sequence);
  return true;
}

interface PendingInputQueue {
  messages: string[];
  bytes: number;
}

interface ManagedTerminal {
  tab: Tab;
  terminal: Terminal;
  fit: FitAddon;
  container: HTMLElement;
  cwd: string;
  resizeTimer: number | null;
  lastResizeCols: number | null;
  lastResizeRows: number | null;
  /** Consecutive failed PTY resizes; bounds the retry loop in maybeResizePty. */
  resizeRetries: number;
  /** Raw output byte-chunks awaiting an xterm write; coalesced on flush. */
  pendingOutput: Uint8Array[];
  pendingOutputBytes: number;
  writeInFlight: boolean;
  writeInFlightBytes: number;
  writeTimer: number | null;
  outputGeneration: number;
  /** Absolute server output bytes accepted into this xterm pipeline. */
  outputCursor: number | null;
  connectionGeneration: number;
  /** Latest React host ownership token; stale cleanup may not park a newer host. */
  hostGeneration: number;
  recoveryPending: boolean;
  recoveryTimer: number | null;
  /**
   * True while a wheel-driven mouse report has been sent to a mouse-tracking TUI
   * and its response has not drained through xterm. Gates the next report so
   * scrolling follows renderer throughput instead of trackpad event frequency.
   */
  awaitingWheelResponse: boolean;
  /** Watchdog preventing a silent TUI report from wedging the rest of a gesture. */
  wheelResponseTimer: number | null;
  /** Whether response bytes arrived but remain in xterm's parser queue. */
  wheelResponsePending: boolean;
  /** Monotonic count of frames xterm reports as painted. */
  wheelRenderGeneration: number;
  /** Render generation when response parsing drained; next frame releases input. */
  wheelResponseParsedRenderGeneration: number | null;
  /** Latest wheel reports retained while the prior TUI redraw drains. */
  pendingWheelInput: string[];
  /** Live PTY event channel, retained so dispose() can detach its handler. */
  stream: PtyStream | null;
  /** Active GPU renderer, retained while hidden unless evicted from the bounded LRU. */
  webgl: WebglAddon | null;
  webglRecoveryAttempts: number;
  webglRecoveryTimer: number | null;
  /** Whether the terminal is currently painted in its pane. */
  visible: boolean;
  /** File-path link provider registration, disposed with the terminal. */
  fileLinkProvider: IDisposable | null;
}

/** Checks whether a delayed focus request still targets the mounted terminal. */
function isFocusableTerminalMount(
  live: ManagedTerminal | undefined,
  requested: ManagedTerminal | undefined,
  hostGeneration: number | undefined,
): live is ManagedTerminal {
  if (!live || !live.visible || !live.container.isConnected) return false;
  if (requested === undefined) return true;
  return live === requested && live.hostGeneration === hostGeneration;
}

/** Leaves focus with text inputs and modal controls unless terminal focus is forced. */
function focusIsClaimed(activeElement: Element | null): boolean {
  const textInputFocused =
    isTextEditingContext(activeElement) && !isTerminalEditingContext(activeElement);
  const dialogOpen = activeElement?.closest('[role="dialog"], [role="alertdialog"]') !== null;
  return textInputFocused || dialogOpen;
}

// Nerd Font variants ship full text-presentation glyph coverage for
// box-drawing / block / powerline characters, which most dev machines
// already have installed. We fall through to the system monospaces that
// actually exist on macOS (SF Mono, Menlo, Monaco) and Linux
// (DejaVu/Liberation via the CSS `ui-monospace` keyword) so the chain
// always resolves to a real font, not the generic `monospace` family
// which renders block characters with inconsistent metrics.
export const TERMINAL_FONT_FAMILY =
  '"JetBrainsMonoNL Nerd Font", "JetBrainsMono Nerd Font", "JetBrains Mono", "SF Mono", Menlo, Monaco, "ui-monospace", monospace';

// 14px is the size Nerd Font's block / box-drawing glyphs are designed
// against — at 13px macOS WebKit rounds the cell to 15px (1.15× the
// line-box height) and the half-block glyphs end up with a 1px
// anti-aliased seam running through the middle of every character,
// which reads as a visible strikethrough across Claude Code / opencode
// ASCII art. 14px snaps the cell to a cleaner integer pixel grid.
export const TERMINAL_FONT_SIZE = 14;
export const TERMINAL_LINE_HEIGHT = 1.0;

/** Non-React xterm registry; terminal output never enters React state. */
export class TerminalManager {
  static readonly fontFamily = TERMINAL_FONT_FAMILY;
  static readonly fontSize = TERMINAL_FONT_SIZE;
  static readonly lineHeight = TERMINAL_LINE_HEIGHT;

  private terminals = new Map<string, ManagedTerminal>();
  private webglLru = new Map<string, ManagedTerminal>();
  private pendingInput = new Map<string, PendingInputQueue>();
  private nextHostGeneration = 0;
  // Title listeners are keyed by tab id and kept **independent of the terminal's
  // lifecycle** so a consumer can subscribe before the terminal is mounted (e.g.
  // a background tab) and still receive shell-emitted titles once it connects.
  // Storing them inside ManagedTerminal would silently drop subscriptions made
  // before mount() or after a re-parent.
  private titleListeners = new Map<string, Set<TitleListener>>();
  // Exit listeners are one-shot in practice (a PTY exits once) but follow the
  // same keyed-Set shape as titleListeners for consistency; cleaned up in
  // dispose() rather than lingering like title subscriptions do.
  private exitListeners = new Map<string, Set<ExitListener>>();
  private findRequestListeners = new Map<string, Set<() => void>>();
  /** Local mirror of each tab's not-yet-submitted shell input line; see {@link applyLocalEcho}. */
  private inputLineBuffers = new Map<string, string>();
  /** Whether the local input mirror still knows the shell cursor position. */
  private inputLineConfidence = new Map<string, boolean>();
  /** Live marker/decoration disposables for the current find highlight, per tab. */
  private fuzzyHighlightDisposables = new Map<string, IDisposable[]>();

  mount(tab: Tab, cwd: string, element: HTMLElement): number {
    const hostGeneration = ++this.nextHostGeneration;
    const existing = this.terminals.get(tab.id);
    if (existing) {
      // Re-parent the live xterm DOM into the host element. React unmounts and
      // recreates host nodes when switching projects/worktrees; moving the
      // managed container keeps the terminal painted instead of going blank.
      if (existing.container.parentElement !== element) {
        element.appendChild(existing.container);
      }
      existing.tab = tab;
      existing.cwd = cwd;
      existing.hostGeneration = hostGeneration;
      this.fit(tab.id);
      return hostGeneration;
    }

    const container = document.createElement("div");
    container.className = "h-full w-full";
    // Force text presentation for any emoji that TUIs emit (Claude Code / opencode
    // ship arrows like ❯ and box characters like ▀▀▀▀) so the macOS WebKit does not
    // silently substitute Apple Color Emoji, which renders them rounded and
    // mis-aligned against the monospace grid.
    container.style.fontVariantEmoji = "text";
    element.appendChild(container);

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: TERMINAL_LINE_HEIGHT,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      // Lines scrolled per wheel delta. This is the fix for local scrolling that feels
      // slow next to Terminal.app/iTerm, and it matters most on a trackpad:
      // xterm multiplies the delta by this option *before* it branches on
      // deltaMode, then — for pixel deltas — divides by the cell height and
      // additionally damps anything under 50px by 0.3. Trackpad deltas are
      // almost all under 50px, so stock xterm moves a Mac trackpad at ~30% of
      // the distance your finger travelled. 3 cancels that damping (3 × 0.3 ≈ 1)
      // and simultaneously brings a discrete mouse wheel up from xterm's 1 line
      // per notch to the ~3 other terminals use. `fastScrollSensitivity` is left
      // at its default because xterm multiplies the two together, so alt-scroll
      // scales with this automatically. The wheel handler switches this to 1
      // while a TUI captures the mouse because each threshold crossing is one
      // PTY report regardless of this value.
      scrollSensitivity: LOCAL_SCROLL_SENSITIVITY,
      // SearchAddon's match/active-match decorations call the proposed
      // `registerDecoration` API; without this it throws the moment a find
      // has a real match, so highlighting (and the resultCount event it
      // gates) silently breaks.
      allowProposedApi: true,
      theme: {
        background: "#0b0d10",
        foreground: "#e5e7eb",
        cursor: "#f8fafc",
        selectionBackground: "#334155",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    // Web links open through the workspace handler rather than the OS browser:
    // Shift+click opens the URL in a browser split to the right; Alt/Option+
    // Shift+click opens it in the system browser instead. A plain click is left
    // to xterm (selection / TUI mouse reporting) — Shift is the deliberate
    // "open this link" gesture, and also bypasses a TUI's mouse tracking.
    terminal.loadAddon(
      new WebLinksAddon((event, uri) => {
        const handler = getTerminalLinkHandler();
        if (!handler || !event.shiftKey) {
          return;
        }
        handler.openUrl({
          tabId: tab.id,
          worktreeId: tab.worktreeId,
          url: uri,
          external: event.altKey,
        });
      }),
    );
    terminal.attachCustomKeyEventHandler((event) => handleTerminalKeyEvent(this, tab.id, event));
    // Let xterm consume every wheel event so its pixel accumulator preserves the
    // gesture distance. onData below paces only reports xterm actually emits.
    // A new gesture may recover from a prior report that answered with silence.
    // `lastWheelEvent` starts at -Infinity so the first event always begins a
    // gesture (performance.now() can still be near zero early in page life).
    let lastWheelEvent = -Infinity;
    let wheelEventMayReport = false;
    let wheelEventGeneration = 0;
    terminal.attachCustomWheelEventHandler(() => {
      const mouseTracking = terminal.modes.mouseTrackingMode !== "none";
      const scrollSensitivity = mouseTracking ? TUI_SCROLL_SENSITIVITY : LOCAL_SCROLL_SENSITIVITY;
      if (terminal.options.scrollSensitivity !== scrollSensitivity) {
        // Sensitivity scales xterm's mouse-report frequency, not lines encoded
        // in each report. Keep damping compensation only for local scrollback.
        terminal.options.scrollSensitivity = scrollSensitivity;
      }
      if (!mouseTracking) {
        return true;
      }
      const now = performance.now();
      const startsNewGesture = now - lastWheelEvent >= MOUSE_WHEEL_GESTURE_QUIET_MS;
      lastWheelEvent = now;
      if (managed.awaitingWheelResponse && !managed.wheelResponsePending && startsNewGesture) {
        // No output means the prior report likely hit a scroll boundary. Drop
        // its stale queued tail so a deliberate new gesture starts immediately.
        this.resetWheelPacing(managed);
      }
      wheelEventMayReport = true;
      const generation = ++wheelEventGeneration;
      queueMicrotask(() => {
        if (wheelEventGeneration === generation) {
          wheelEventMayReport = false;
        }
      });
      return true;
    });
    terminal.open(container);
    const managed: ManagedTerminal = {
      tab,
      terminal,
      fit,
      container,
      cwd,
      resizeTimer: null,
      lastResizeCols: null,
      lastResizeRows: null,
      resizeRetries: 0,
      pendingOutput: [],
      pendingOutputBytes: 0,
      writeInFlight: false,
      writeInFlightBytes: 0,
      writeTimer: null,
      outputGeneration: 0,
      outputCursor: null,
      connectionGeneration: 0,
      hostGeneration,
      recoveryPending: false,
      recoveryTimer: null,
      awaitingWheelResponse: false,
      wheelResponseTimer: null,
      wheelResponsePending: false,
      wheelRenderGeneration: 0,
      wheelResponseParsedRenderGeneration: null,
      pendingWheelInput: [],
      stream: null,
      webgl: null,
      webglRecoveryAttempts: 0,
      webglRecoveryTimer: null,
      visible: true,
      fileLinkProvider: null,
    };
    this.enableWebglRenderer(managed);
    // Linkify existing worktree files printed in the terminal so a click opens
    // them in an editor split to the right (validated against the worktree, so
    // only real files are decorated). cwd is the worktree root.
    managed.fileLinkProvider = terminal.registerLinkProvider(
      createFileLinkProvider(terminal, tab.id, tab.worktreeId, cwd),
    );
    this.terminals.set(tab.id, managed);
    terminal.onData((data) => {
      // xterm emits wheel reports synchronously after the custom wheel handler.
      // Fractional events emit nothing and still reach its pixel accumulator.
      if (wheelEventMayReport && terminal.modes.mouseTrackingMode !== "none") {
        wheelEventMayReport = false;
        this.enqueueWheelInput(tab.id, managed, data);
        return;
      }
      const pendingLine = this.inputLineBuffers.get(tab.id) ?? "";
      if ((data === "\r" || data === "\n") && pendingLine.trim()) {
        announceSubmittedCommand(pendingLine);
      }
      if (!preservesLocalEchoConfidence(data)) {
        this.inputLineConfidence.set(tab.id, false);
      }
      this.inputLineBuffers.set(tab.id, applyLocalEcho(pendingLine, data));
      this.writeWhenReady(tab.id, data);
    });
    terminal.onRender(() => {
      if (managed.webgl) {
        // A successful paint ends a consecutive context-loss recovery streak.
        managed.webglRecoveryAttempts = 0;
      }
      managed.wheelRenderGeneration += 1;
      const parsedGeneration = managed.wheelResponseParsedRenderGeneration;
      if (
        !managed.awaitingWheelResponse ||
        parsedGeneration === null ||
        managed.wheelRenderGeneration <= parsedGeneration
      ) {
        return;
      }
      if (managed.wheelResponseTimer !== null) {
        window.clearTimeout(managed.wheelResponseTimer);
        managed.wheelResponseTimer = null;
      }
      managed.awaitingWheelResponse = false;
      managed.wheelResponseParsedRenderGeneration = null;
      this.flushPendingWheelInput(tab.id, managed);
    });
    this.connect(tab, cwd, managed);
    this.fit(tab.id);
    return hostGeneration;
  }

  /** Fits a mounted terminal without changing keyboard focus. */
  activate(tabId: string): void {
    window.requestAnimationFrame(() => this.fit(tabId));
  }

  /** Focuses one visible xterm after React has mounted and revealed its host. */
  focus(tabId: string, force = false): void {
    const requested = this.terminals.get(tabId);
    const hostGeneration = requested?.hostGeneration;
    window.requestAnimationFrame(() => {
      const live = this.terminals.get(tabId);
      const activeElement = document.activeElement;
      if (!isFocusableTerminalMount(live, requested, hostGeneration)) return;
      if (!force && focusIsClaimed(activeElement)) return;
      live.terminal.focus();
    });
  }

  /** Toggles rendering without detaching the PTY stream or discarding xterm state. */
  setVisible(tabId: string, visible: boolean): void {
    const managed = this.terminals.get(tabId);
    if (!managed || managed.visible === visible) {
      return;
    }
    managed.visible = visible;
    if (visible) {
      if (this.enableWebglRenderer(managed)) {
        managed.terminal.refresh(0, managed.terminal.rows - 1);
      }
      this.activate(tabId);
    } else {
      this.trimHiddenWebglRenderers();
    }
  }

  clear(tabId: string): void {
    const managed = this.terminals.get(tabId);
    if (!managed) {
      return;
    }
    managed.terminal.clear();
  }

  /** Writes input once a tab's daemon PTY connection exists. */
  writeWhenReady(tabId: string, data: string): boolean {
    if (data.length === 0) {
      return true;
    }
    const managed = this.terminals.get(tabId);
    if (managed?.stream) {
      invokePtyInput(tabId, data);
      return true;
    }
    const bytes = new TextEncoder().encode(data).byteLength;
    const pending = this.pendingInput.get(tabId) ?? { messages: [], bytes: 0 };
    if (
      pending.messages.length >= TERMINAL_PENDING_INPUT_MAX_MESSAGES ||
      pending.bytes + bytes > TERMINAL_PENDING_INPUT_MAX_BYTES
    ) {
      const error = new Error(`terminal input queue is full before ${tabId} is connected`);
      console.error(error.message);
      managed?.terminal.writeln(`\r\n[${error.message}]`);
      return false;
    }
    pending.messages.push(data);
    pending.bytes += bytes;
    this.pendingInput.set(tabId, pending);
    return true;
  }

  /** Parks an unmounted view without touching its xterm parser or PTY stream. */
  park(tabId: string, hostGeneration: number): void {
    const managed = this.terminals.get(tabId);
    if (!managed || managed.hostGeneration !== hostGeneration) {
      return;
    }
    managed.visible = false;
    this.trimHiddenWebglRenderers();
  }

  /** Scrolls the terminal viewport to the bottom (the live cursor row). */
  scrollToBottom(tabId: string): void {
    const managed = this.terminals.get(tabId);
    if (!managed) {
      return;
    }
    managed.terminal.scrollToBottom();
  }

  resize(tabId: string): void {
    const managed = this.terminals.get(tabId);
    if (!managed) {
      return;
    }
    if (managed.resizeTimer !== null) {
      window.clearTimeout(managed.resizeTimer);
    }
    managed.resizeTimer = window.setTimeout(() => {
      managed.resizeTimer = null;
      this.fit(tabId);
    }, RESIZE_DEBOUNCE_MS);
  }

  dispose(tabId: string): void {
    const managed = this.terminals.get(tabId);
    if (!managed) {
      return;
    }
    if (managed.resizeTimer !== null) {
      window.clearTimeout(managed.resizeTimer);
    }
    if (managed.recoveryTimer !== null) {
      window.clearTimeout(managed.recoveryTimer);
    }
    if (managed.writeTimer !== null) {
      window.clearTimeout(managed.writeTimer);
    }
    managed.connectionGeneration += 1;
    this.resetOutput(managed);
    managed.fileLinkProvider?.dispose();
    managed.fileLinkProvider = null;
    this.disableWebglRenderer(managed);
    // Detach the channel handler so Tauri stops delivering events to a disposed
    // terminal, then tell the daemon to tear down the shell — without this the
    // shell process and its scrollback leak for the lifetime of the daemon.
    if (managed.stream) {
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri Channel exposes `onmessage` rather than EventTarget listeners.
      managed.stream.channel.onmessage = () => {};
      void ptyDetach(tabId, managed.stream.generation);
      managed.stream = null;
    }
    managed.terminal.dispose();
    managed.container.remove();
    this.terminals.delete(tabId);
    this.pendingInput.delete(tabId);
    this.exitListeners.delete(tabId);
    this.findRequestListeners.delete(tabId);
    this.inputLineBuffers.delete(tabId);
    this.inputLineConfidence.delete(tabId);
    inputErrorTabs.delete(tabId);
    this.clearFuzzyHighlights(tabId);
    void ptyKill(tabId);
  }

  /** Every buffer row (scrollback + viewport) as plain text, for fuzzy-scanning. */
  getBufferLines(tabId: string): string[] {
    const managed = this.terminals.get(tabId);
    if (!managed) {
      return [];
    }
    const buffer = managed.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    }
    return lines;
  }

  /**
   * Replaces the current find highlight with `matches`, painting `activeIndex`
   * distinctly. Uses xterm's marker/decoration API directly (proposed, hence
   * `allowProposedApi` above) since there's no built-in fuzzy search to lean
   * on. `registerMarker`'s offset is relative to the cursor's current absolute
   * row, so each match's absolute row is converted relative to that.
   */
  setFuzzyHighlights(tabId: string, matches: TerminalFuzzyMatch[], activeIndex: number): void {
    const managed = this.terminals.get(tabId);
    if (!managed) {
      return;
    }
    this.clearFuzzyHighlights(tabId);
    const buffer = managed.terminal.buffer.active;
    const cursorAbsoluteRow = buffer.baseY + buffer.cursorY;
    const disposables: IDisposable[] = [];
    matches.forEach((match, index) => {
      const marker = managed.terminal.registerMarker(match.row - cursorAbsoluteRow);
      if (!marker) {
        return;
      }
      disposables.push(marker);
      const decoration = managed.terminal.registerDecoration({
        marker,
        x: match.from,
        width: Math.max(1, match.to - match.from),
        backgroundColor: index === activeIndex ? "#b45309" : "#334155",
      });
      if (decoration) {
        disposables.push(decoration);
      }
    });
    this.fuzzyHighlightDisposables.set(tabId, disposables);
  }

  /** Clears the current find highlight, if any. */
  clearFuzzyHighlights(tabId: string): void {
    const existing = this.fuzzyHighlightDisposables.get(tabId);
    if (existing) {
      for (const disposable of existing) {
        disposable.dispose();
      }
      this.fuzzyHighlightDisposables.delete(tabId);
    }
  }

  /** Scrolls the viewport to an absolute buffer row (e.g. to reveal the active match). */
  scrollToBufferRow(tabId: string, row: number): void {
    this.terminals.get(tabId)?.terminal.scrollToLine(row);
  }

  /** Subscribes to Cmd/Ctrl+F pressed while this tab's terminal has focus. */
  onRequestFind(tabId: string, listener: () => void): () => void {
    let listeners = this.findRequestListeners.get(tabId);
    if (!listeners) {
      listeners = new Set();
      this.findRequestListeners.set(tabId, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.findRequestListeners.get(tabId);
      if (!set) {
        return;
      }
      set.delete(listener);
      if (set.size === 0) {
        this.findRequestListeners.delete(tabId);
      }
    };
  }

  /** Called from the terminal's custom key handler on Cmd/Ctrl+F. */
  requestFind(tabId: string): void {
    const listeners = this.findRequestListeners.get(tabId);
    if (listeners) {
      for (const listener of listeners) {
        listener();
      }
    }
  }

  /** The not-yet-submitted shell input line, per {@link applyLocalEcho}'s best-effort model. */
  getPendingInputLine(tabId: string): string {
    return this.inputLineBuffers.get(tabId) ?? "";
  }

  /** Whether replacing can safely rewrite the shell's current input line. */
  canReplacePendingInput(tabId: string): boolean {
    return this.inputLineConfidence.get(tabId) ?? true;
  }

  /**
   * Rewrites the tab's pending input line to `next` by sending backspaces for
   * the tracked length followed by the new text — Replace only ever touches
   * this unsent line, never the PTY's scrollback/output.
   */
  replaceInPendingInput(tabId: string, next: string): void {
    if (!this.canReplacePendingInput(tabId)) {
      return;
    }
    const current = this.inputLineBuffers.get(tabId) ?? "";
    if (current === next) {
      return;
    }
    this.writeWhenReady(tabId, "\x7f".repeat(current.length) + next);
    this.inputLineBuffers.set(tabId, next);
  }

  private fit(tabId: string): void {
    const managed = this.terminals.get(tabId);
    if (!managed?.terminal.element?.offsetParent) {
      return;
    }
    const dimensions = managed.fit.proposeDimensions();
    if (!dimensions) {
      return;
    }
    const cols = Math.max(2, Math.min(dimensions.cols, MAX_TERMINAL_COLS));
    const rows = Math.max(1, Math.min(dimensions.rows, MAX_TERMINAL_ROWS));
    this.applyFit(managed, dimensions, cols, rows);
    this.maybeResizePty(managed, tabId);
  }

  /** Applies the proposed dimensions to xterm, fitting when in bounds or resizing when clamped. */
  private applyFit(
    managed: ManagedTerminal,
    dimensions: { cols: number; rows: number },
    cols: number,
    rows: number,
  ): void {
    if (dimensions.cols === cols && dimensions.rows === rows) {
      managed.fit.fit();
    } else if (managed.terminal.cols !== cols || managed.terminal.rows !== rows) {
      managed.terminal.resize(cols, rows);
    }
  }

  /** Forwards the fitted grid to the PTY only when it actually changed. */
  private maybeResizePty(managed: ManagedTerminal, tabId: string): void {
    const fittedCols = managed.terminal.cols;
    const fittedRows = managed.terminal.rows;
    if (managed.lastResizeCols === fittedCols && managed.lastResizeRows === fittedRows) {
      return;
    }
    managed.lastResizeCols = fittedCols;
    managed.lastResizeRows = fittedRows;
    ptyResize(tabId, fittedCols, fittedRows)
      .then(() => {
        managed.resizeRetries = 0;
        return undefined;
      })
      .catch(() => {
        // The resize raced the session's spawn (or a daemon restart) and was
        // dropped server-side. Clear the cache — it now records a size the PTY
        // never received — and retry shortly, so the PTY doesn't stay at its
        // 80x24 spawn default. Bounded so a genuinely dead session can't loop.
        if (managed.lastResizeCols === fittedCols && managed.lastResizeRows === fittedRows) {
          managed.lastResizeCols = null;
          managed.lastResizeRows = null;
        }
        if (managed.resizeRetries >= MAX_RESIZE_RETRIES) {
          return;
        }
        managed.resizeRetries += 1;
        window.setTimeout(() => {
          if (this.terminals.get(tabId) === managed) {
            this.fit(tabId);
          }
        }, RESIZE_RETRY_MS);
      });
  }

  private enqueueOutput(tabId: string, managed: ManagedTerminal, data: Uint8Array): boolean {
    // Response bytes prove the TUI consumed the report, but the renderer may
    // still be behind. Keep the gate closed until flushOutput drains its parser
    // queue, otherwise every wheel event adds another full-grid redraw.
    if (managed.awaitingWheelResponse) {
      managed.wheelResponsePending = true;
      if (managed.wheelResponseTimer !== null) {
        window.clearTimeout(managed.wheelResponseTimer);
        managed.wheelResponseTimer = null;
      }
    }
    if (
      managed.pendingOutputBytes + managed.writeInFlightBytes + data.length >
      TERMINAL_PENDING_OUTPUT_MAX_BYTES
    ) {
      this.restartStream(tabId, managed);
      return false;
    }
    managed.pendingOutput.push(data);
    managed.pendingOutputBytes += data.length;
    if (!managed.writeInFlight) {
      this.flushOutput(managed);
    }
    return true;
  }

  private enqueueWheelInput(tabId: string, managed: ManagedTerminal, data: string): void {
    if (!managed.awaitingWheelResponse) {
      this.sendWheelInput(tabId, managed, data);
      return;
    }
    if (managed.pendingWheelInput.length === TUI_WHEEL_PENDING_REPORTS) {
      managed.pendingWheelInput.shift();
    }
    managed.pendingWheelInput.push(data);
  }

  private sendWheelInput(tabId: string, managed: ManagedTerminal, data: string): void {
    managed.awaitingWheelResponse = true;
    managed.wheelResponsePending = false;
    managed.wheelResponseParsedRenderGeneration = null;
    this.armWheelResponseWatchdog(tabId, managed);
    this.writeWhenReady(tabId, data);
  }

  private armWheelResponseWatchdog(tabId: string, managed: ManagedTerminal): void {
    if (managed.wheelResponseTimer !== null) {
      window.clearTimeout(managed.wheelResponseTimer);
    }
    managed.wheelResponseTimer = window.setTimeout(() => {
      managed.wheelResponseTimer = null;
      if (!managed.awaitingWheelResponse || this.terminals.get(tabId) !== managed) {
        return;
      }
      managed.awaitingWheelResponse = false;
      managed.wheelResponsePending = false;
      managed.wheelResponseParsedRenderGeneration = null;
      this.flushPendingWheelInput(tabId, managed);
    }, MOUSE_WHEEL_RESPONSE_TIMEOUT_MS);
  }

  private armWheelRenderWatchdog(tabId: string, managed: ManagedTerminal): void {
    if (managed.wheelResponseTimer !== null) {
      window.clearTimeout(managed.wheelResponseTimer);
    }
    const parsedGeneration = managed.wheelResponseParsedRenderGeneration;
    managed.wheelResponseTimer = window.setTimeout(() => {
      managed.wheelResponseTimer = null;
      if (
        !managed.awaitingWheelResponse ||
        managed.wheelResponseParsedRenderGeneration !== parsedGeneration ||
        this.terminals.get(tabId) !== managed
      ) {
        return;
      }
      managed.awaitingWheelResponse = false;
      managed.wheelResponseParsedRenderGeneration = null;
      this.flushPendingWheelInput(tabId, managed);
    }, MOUSE_WHEEL_RENDER_TIMEOUT_MS);
  }

  private flushPendingWheelInput(tabId: string, managed: ManagedTerminal): void {
    if (managed.pendingWheelInput.length === 0) {
      return;
    }
    const input = managed.pendingWheelInput.join("");
    managed.pendingWheelInput = [];
    this.sendWheelInput(tabId, managed, input);
  }

  private resetWheelPacing(managed: ManagedTerminal): void {
    if (managed.wheelResponseTimer !== null) {
      window.clearTimeout(managed.wheelResponseTimer);
      managed.wheelResponseTimer = null;
    }
    managed.awaitingWheelResponse = false;
    managed.wheelResponsePending = false;
    managed.wheelResponseParsedRenderGeneration = null;
    managed.pendingWheelInput = [];
  }

  /** Loads xterm's GPU renderer and retains recently hidden contexts for instant tab switches. */
  private enableWebglRenderer(managed: ManagedTerminal): boolean {
    if (managed.webgl) {
      this.touchWebglRenderer(managed);
      return false;
    }
    this.evictHiddenWebglRenderer();
    let webgl: WebglAddon | null = null;
    try {
      const candidate = new WebglAddon();
      webgl = candidate;
      candidate.onContextLoss(() => {
        if (managed.webgl === candidate) {
          managed.webgl = null;
          this.webglLru.delete(managed.tab.id);
          this.scheduleWebglRecovery(managed);
        }
        candidate.dispose();
      });
      managed.terminal.loadAddon(candidate);
      managed.webgl = candidate;
      this.touchWebglRenderer(managed);
      return true;
    } catch (error) {
      webgl?.dispose();
      // WebGL unavailable (e.g. headless CI); keep the DOM renderer. Warn rather
      // than making the slow path indistinguishable from an application bug.
      console.warn("WebGL renderer unavailable; falling back to the DOM renderer", error);
      this.scheduleWebglRecovery(managed);
      return false;
    }
  }

  private touchWebglRenderer(managed: ManagedTerminal): void {
    this.webglLru.delete(managed.tab.id);
    this.webglLru.set(managed.tab.id, managed);
  }

  private evictHiddenWebglRenderer(): boolean {
    if (this.webglLru.size < WEBGL_RENDERER_CACHE_SIZE) {
      return false;
    }
    for (const candidate of this.webglLru.values()) {
      if (!candidate.visible) {
        this.disableWebglRenderer(candidate);
        return true;
      }
    }
    return false;
  }

  private trimHiddenWebglRenderers(): void {
    while (this.webglLru.size > WEBGL_RENDERER_CACHE_SIZE && this.evictHiddenWebglRenderer()) {
      // Keep visible split panes GPU-backed; shed each excess context as soon
      // as enough panes become hidden again.
    }
  }

  private scheduleWebglRecovery(managed: ManagedTerminal): void {
    if (
      !managed.visible ||
      managed.webglRecoveryTimer !== null ||
      managed.webglRecoveryAttempts >= WEBGL_RECOVERY_MAX_ATTEMPTS
    ) {
      return;
    }
    managed.webglRecoveryAttempts += 1;
    managed.webglRecoveryTimer = window.setTimeout(() => {
      managed.webglRecoveryTimer = null;
      if (this.terminals.get(managed.tab.id) !== managed || !managed.visible) {
        return;
      }
      if (this.enableWebglRenderer(managed)) {
        managed.terminal.refresh(0, managed.terminal.rows - 1);
      }
    }, WEBGL_RECOVERY_DELAY_MS);
  }

  private disableWebglRenderer(managed: ManagedTerminal): void {
    if (managed.webglRecoveryTimer !== null) {
      window.clearTimeout(managed.webglRecoveryTimer);
      managed.webglRecoveryTimer = null;
    }
    this.webglLru.delete(managed.tab.id);
    const webgl = managed.webgl;
    managed.webgl = null;
    managed.webglRecoveryAttempts = 0;
    webgl?.dispose();
  }

  private flushOutput(managed: ManagedTerminal): void {
    const data = takeOutputChunk(managed.pendingOutput, TERMINAL_WRITE_CHUNK_MAX_BYTES);
    managed.pendingOutputBytes -= data.length;
    if (data.length === 0) {
      managed.writeInFlight = false;
      managed.writeInFlightBytes = 0;
      return;
    }
    const generation = managed.outputGeneration;
    managed.writeInFlight = true;
    managed.writeInFlightBytes = data.length;
    this.armWriteWatchdog(managed, generation);
    managed.terminal.write(data, () => {
      if (this.terminals.get(managed.tab.id) !== managed) {
        return;
      }
      managed.writeInFlight = false;
      managed.writeInFlightBytes = 0;
      if (managed.writeTimer !== null) {
        window.clearTimeout(managed.writeTimer);
        managed.writeTimer = null;
      }
      if (managed.outputGeneration !== generation) {
        if (managed.recoveryPending) {
          this.finishStreamRecovery(managed.tab.id, managed);
        }
        return;
      }
      // Drain straight into the next write rather than waiting for an animation
      // frame. xterm's own WriteBuffer already time-slices parsing and defers
      // painting to a frame, so this callback means "the parser consumed it" —
      // it is the backpressure signal, and an extra rAF on top only adds a frame
      // of latency per chunk. That capped the drain rate at ~60 chunks/s while
      // the server coalesces every 8ms (~125/s), so a repainting TUI fell
      // steadily further behind: paints arrived late and wheel-driven redraws
      // kept arriving after the scroll had stopped.
      if (managed.pendingOutput.length > 0) {
        this.flushOutput(managed);
      } else if (managed.wheelResponsePending) {
        managed.wheelResponsePending = false;
        managed.wheelResponseParsedRenderGeneration = managed.wheelRenderGeneration;
        this.armWheelRenderWatchdog(managed.tab.id, managed);
      }
    });
  }

  private armWriteWatchdog(managed: ManagedTerminal, generation: number): void {
    if (managed.writeTimer !== null) {
      window.clearTimeout(managed.writeTimer);
    }
    managed.writeTimer = window.setTimeout(() => {
      managed.writeTimer = null;
      if (
        this.terminals.get(managed.tab.id) !== managed ||
        managed.outputGeneration !== generation ||
        !managed.writeInFlight ||
        managed.recoveryPending
      ) {
        return;
      }
      this.restartStream(managed.tab.id, managed);
    }, TERMINAL_WRITE_DRAIN_TIMEOUT_MS);
  }

  /**
   * Subscribes to shell-emitted title updates (OSC 0/2) for a tab. The
   * listener is called for every title update the PTY produces; consumers
   * (typically the workspace reducer) decide whether to apply it to the
   * tab strip based on whether the user has manually renamed the tab.
   *
   * Subscriptions are independent of the terminal's mount lifecycle: it is
   * valid (and expected) to subscribe before the terminal is mounted, so a
   * tab that becomes visible later still receives its shell titles.
   */
  onTitle(tabId: string, listener: TitleListener): () => void {
    let listeners = this.titleListeners.get(tabId);
    if (!listeners) {
      listeners = new Set();
      this.titleListeners.set(tabId, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.titleListeners.get(tabId);
      if (!set) {
        return;
      }
      set.delete(listener);
      if (set.size === 0) {
        this.titleListeners.delete(tabId);
      }
    };
  }

  /**
   * Subscribes to the PTY process exiting for a tab. Fires once, when the
   * underlying shell exits on its own (not when the tab is closed/disposed
   * from the UI, since that detaches the channel handler first).
   */
  onExit(tabId: string, listener: ExitListener): () => void {
    let listeners = this.exitListeners.get(tabId);
    if (!listeners) {
      listeners = new Set();
      this.exitListeners.set(tabId, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.exitListeners.get(tabId);
      if (!set) {
        return;
      }
      set.delete(listener);
      if (set.size === 0) {
        this.exitListeners.delete(tabId);
      }
    };
  }

  private connect(tab: Tab, cwd: string, managed: ManagedTerminal): void {
    const tabId = tab.id;
    const connectionGeneration = ++managed.connectionGeneration;
    const isCurrentConnection = () => {
      const live = this.terminals.get(tabId);
      return live === managed && managed.connectionGeneration === connectionGeneration;
    };
    const onEvent = (message: PtyMessage) => {
      if (managed.connectionGeneration !== connectionGeneration) {
        return;
      }
      this.handlePtyMessage(tabId, managed, message);
    };
    const cols = managed.terminal.cols || 80;
    const rows = managed.terminal.rows || 24;
    const cursor = managed.outputCursor;
    ptyAttach(tabId, cols, rows, cursor, onEvent)
      .catch(() => {
        // Recovery or disposal can supersede this attach while it is in flight.
        // Only the current generation may create the missing shell.
        if (!isCurrentConnection()) {
          return null;
        }
        if (cursor !== null) {
          // Session disappeared (usually server restart). Rebuild xterm before
          // spawning a replacement shell rather than appending a new session to
          // stale terminal state.
          this.restartStream(tabId, managed);
          return null;
        }
        // The tab's own shell profile, so a session respawned after a server
        // restart returns to the shell it was opened with rather than the
        // current default.
        return ptySpawn(tabId, tab.worktreeId, cwd, cols, rows, onEvent, tab.shell ?? null).catch(
          (spawnError) => {
            if (!isCurrentConnection()) {
              return null;
            }
            // Another creator may have won between attach and spawn. Re-attach
            // once; preserve the spawn error when no session actually appeared.
            return ptyAttach(tabId, cols, rows, null, onEvent).catch(() =>
              Promise.reject(spawnError),
            );
          },
        );
      })
      .then((stream) => {
        if (!stream) {
          return undefined;
        }
        const live = this.terminals.get(tabId);
        if (!live || live !== managed || live.connectionGeneration !== connectionGeneration) {
          // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri Channel exposes `onmessage` rather than EventTarget listeners.
          stream.channel.onmessage = () => {};
          void ptyDetach(tabId, stream.generation);
          return undefined;
        }
        live.stream = stream;
        const pending = this.pendingInput.get(tabId);
        if (pending) {
          this.pendingInput.delete(tabId);
          invokePtyInput(tabId, pending.messages.join(""));
        }
        // The remote session is brand new — either a fresh spawn, or an attach
        // that fell back to spawn after a daemon reset — and was created with the
        // pre-fit default size (80x24), because connect() runs before the first
        // fit(). The synchronous fit() in mount() may already have cached that
        // real size (and sent a resize to a session that did not exist yet), so
        // clear the cache to force fit() to re-send the current size now that the
        // session exists; otherwise it early-returns and the PTY stays at 80x24
        // while xterm fills the window.
        live.lastResizeCols = null;
        live.lastResizeRows = null;
        this.fit(tabId);
        return undefined;
      })
      .catch((error: unknown) => {
        if (!isCurrentConnection()) {
          return;
        }
        managed.terminal.writeln(
          `\r\n[failed to start terminal: ${
            error instanceof Error ? error.message : String(error)
          }]`,
        );
      });
  }

  // fallow-ignore-next-line complexity -- dispatch over PTY message variants (bytes/replay/title/disconnected/exit); each arm is a single side effect.
  private handlePtyMessage(tabId: string, managed: ManagedTerminal, message: PtyMessage): void {
    // Raw terminal output arrives as bytes (ArrayBuffer); control events as JSON objects.
    if (message instanceof ArrayBuffer) {
      if (this.enqueueOutput(tabId, managed, new Uint8Array(message))) {
        managed.outputCursor = (managed.outputCursor ?? 0) + message.byteLength;
      }
      return;
    }
    if (message.event === "replay") {
      if (message.reset && managed.outputCursor !== null) {
        this.restartStream(tabId, managed);
        return;
      }
      managed.outputCursor = message.cursor;
      return;
    }
    if (message.event === "title") {
      for (const listener of this.titleListeners.get(tabId) ?? []) {
        listener(message.title);
      }
      return;
    }
    if (message.event === "disconnected") {
      this.resumeStream(tabId, managed);
      return;
    }
    managed.terminal.writeln(
      `\r\n[process exited${message.code === null ? "" : ` with ${message.code}`}]`,
    );
    for (const listener of this.exitListeners.get(tabId) ?? []) {
      listener(message.code);
    }
  }

  private detachStream(tabId: string, managed: ManagedTerminal): void {
    const stream = managed.stream;
    if (!stream) {
      return;
    }
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri Channel exposes `onmessage` rather than EventTarget listeners.
    stream.channel.onmessage = () => {};
    managed.stream = null;
    void ptyDetach(tabId, stream.generation);
  }

  private resetOutput(managed: ManagedTerminal): void {
    managed.outputGeneration += 1;
    managed.pendingOutput = [];
    managed.pendingOutputBytes = 0;
    managed.writeInFlight = false;
    managed.writeInFlightBytes = 0;
    if (managed.writeTimer !== null) {
      window.clearTimeout(managed.writeTimer);
      managed.writeTimer = null;
    }
    managed.outputCursor = null;
    this.resetWheelPacing(managed);
  }

  private resumeStream(tabId: string, managed: ManagedTerminal): void {
    if (managed.recoveryPending || this.terminals.get(tabId) !== managed) {
      return;
    }
    managed.connectionGeneration += 1;
    this.detachStream(tabId, managed);
    this.resetWheelPacing(managed);
    this.connect(managed.tab, managed.cwd, managed);
  }

  private restartStream(tabId: string, managed: ManagedTerminal): void {
    if (managed.recoveryPending) {
      return;
    }
    managed.connectionGeneration += 1;
    this.detachStream(tabId, managed);
    managed.outputGeneration += 1;
    managed.pendingOutput = [];
    managed.pendingOutputBytes = 0;
    managed.outputCursor = null;
    managed.recoveryPending = true;
    if (managed.writeTimer !== null) {
      window.clearTimeout(managed.writeTimer);
      managed.writeTimer = null;
    }
    this.resetWheelPacing(managed);
    if (managed.writeInFlight) {
      managed.recoveryTimer = window.setTimeout(() => {
        managed.recoveryTimer = null;
        if (this.terminals.get(tabId) === managed && managed.recoveryPending) {
          this.recreateForStreamRecovery(tabId, managed);
        }
      }, TERMINAL_WRITE_DRAIN_TIMEOUT_MS);
      return;
    }
    this.finishStreamRecovery(tabId, managed);
  }

  private finishStreamRecovery(tabId: string, managed: ManagedTerminal): void {
    if (this.terminals.get(tabId) !== managed || !managed.recoveryPending) {
      return;
    }
    if (managed.recoveryTimer !== null) {
      window.clearTimeout(managed.recoveryTimer);
      managed.recoveryTimer = null;
    }
    managed.recoveryPending = false;
    managed.terminal.reset();
    this.connect(managed.tab, managed.cwd, managed);
  }

  private recreateForStreamRecovery(tabId: string, managed: ManagedTerminal): void {
    const host = managed.container.parentElement ?? document.createElement("div");
    const { tab, cwd, visible, hostGeneration } = managed;
    managed.fileLinkProvider?.dispose();
    this.disableWebglRenderer(managed);
    this.terminals.delete(tabId);
    managed.terminal.dispose();
    managed.container.remove();
    this.mount(tab, cwd, host);
    const replacement = this.terminals.get(tabId);
    if (replacement) {
      // Current React host still owns this widget; keep its cleanup token valid.
      replacement.hostGeneration = hostGeneration;
    }
    this.setVisible(tabId, visible);
  }

  /**
   * Installs the dev-only benchmark hook and returns whether it was installed.
   *
   * `@pragma/bench` measures the terminal from inside the webview, and the
   * WebGL renderer leaves nothing in the DOM to read — no `.xterm-rows`, and a
   * canvas whose pixels are not retrievable. So the benchmark needs the xterm
   * instance itself, which lives only in this registry.
   *
   * The hook holds no references of its own: it resolves a tab id against the
   * live map on every call, so a terminal it looked at once is still disposed,
   * re-parented, and evicted from the WebGL LRU exactly as before. Reading is
   * all it can do; input goes in as DOM events, the same way a user's does.
   */
  installBenchHook(): boolean {
    if (!import.meta.env.DEV) {
      return false;
    }
    const hook: TerminalBenchHook = {
      version: 1,
      tabs: () => [...this.terminals.keys()],
      terminal: (tabId) => this.terminals.get(tabId)?.terminal,
      element: (tabId) => this.terminals.get(tabId)?.container,
    };
    (window as unknown as Record<string, TerminalBenchHook>)[constants.bench.hookGlobal] = hook;
    return true;
  }
}

/**
 * Read-only view of the live terminals, exposed on `window` in dev builds only.
 * The property name is shared with the benchmark through `@pragma/constants`.
 */
interface TerminalBenchHook {
  version: 1;
  tabs: () => string[];
  terminal: (tabId: string) => Terminal | undefined;
  element: (tabId: string) => HTMLElement | undefined;
}

/** Takes at most `maxBytes` from ordered output chunks without joining the whole backlog. */
function takeOutputChunk(chunks: Uint8Array[], maxBytes: number): Uint8Array {
  const first = chunks[0];
  if (!first) {
    return new Uint8Array();
  }
  if (first.length > maxBytes) {
    chunks[0] = first.subarray(maxBytes);
    return first.subarray(0, maxBytes);
  }
  if (first.length === maxBytes || chunks.length === 1) {
    chunks.shift();
    return first;
  }
  const size = Math.min(
    maxBytes,
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  const output = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const chunk = chunks[0]!;
    const take = Math.min(chunk.length, size - offset);
    output.set(chunk.subarray(0, take), offset);
    offset += take;
    if (take === chunk.length) {
      chunks.shift();
    } else {
      chunks[0] = chunk.subarray(take);
    }
  }
  return output;
}

export const terminalManager = new TerminalManager();

// Guarded here as well as inside the method so the call — and with it every
// reference to the hook — is dropped from production bundles.
if (import.meta.env.DEV) {
  terminalManager.installBenchHook();
}
