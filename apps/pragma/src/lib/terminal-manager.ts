import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { Channel } from "@tauri-apps/api/core";

import type { Tab } from "@pragma/constants";

import { actionForEvent, getKeybindingsConfig } from "@/lib/keybindings";
import { nativeEditingSequence } from "@/lib/native-editing";
import { isMacPlatform } from "@/lib/platform";
import { ptyAttach, ptyKill, ptyResize, ptySpawn, ptyWrite, type PtyMessage } from "@/lib/tauri";

const RESIZE_DEBOUNCE_MS = 75;
export const MAX_TERMINAL_COLS = 240;
export const MAX_TERMINAL_ROWS = 90;
export const TERMINAL_SCROLLBACK_LINES = 500;

// Minimum gap between wheel-driven mouse reports while a TUI has mouse tracking
// enabled. xterm emits exactly one mouse report per OS wheel event, and macOS
// momentum trackpad scrolling fires 100+ events/s. A mouse-tracking TUI (Claude
// Code, opencode) redraws its whole grid per report, and consumes reports no
// faster than it can redraw, so an unthrottled flood backs the PTY input up and
// scrolling keeps going after your finger stops (a laggy, floaty tail). Dropping
// (never rewriting) excess reports keeps scroll matched to the TUI. This is the
// knob to tune for scroll feel: lower = faster/farther scroll but more redraw
// load; higher = calmer but a flick scrolls less. When mouse tracking is off,
// xterm scrolls its own viewport locally and is left untouched.
export const MOUSE_WHEEL_REPORT_INTERVAL_MS = 2;

export type TitleListener = (title: string) => void;

interface ManagedTerminal {
  terminal: Terminal;
  fit: FitAddon;
  container: HTMLElement;
  cwd: string;
  resizeTimer: number | null;
  lastResizeCols: number | null;
  lastResizeRows: number | null;
  /** Raw output byte-chunks awaiting an xterm write; coalesced on flush. */
  pendingOutput: Uint8Array[];
  writeInFlight: boolean;
  /** Live PTY event channel, retained so dispose() can detach its handler. */
  channel: Channel<PtyMessage> | null;
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
  // Title listeners are keyed by tab id and kept **independent of the terminal's
  // lifecycle** so a consumer can subscribe before the terminal is mounted (e.g.
  // a background tab) and still receive shell-emitted titles once it connects.
  // Storing them inside ManagedTerminal would silently drop subscriptions made
  // before mount() or after a re-parent.
  private titleListeners = new Map<string, Set<TitleListener>>();

  mount(tab: Tab, cwd: string, element: HTMLElement): void {
    const existing = this.terminals.get(tab.id);
    if (existing) {
      // Re-parent the live xterm DOM into the host element. React unmounts and
      // recreates host nodes when switching projects/worktrees; moving the
      // managed container keeps the terminal painted instead of going blank.
      if (existing.container.parentElement !== element) {
        element.appendChild(existing.container);
      }
      this.fit(tab.id);
      return;
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
      theme: {
        background: "#0b0d10",
        foreground: "#e5e7eb",
        cursor: "#f8fafc",
        selectionBackground: "#334155",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    terminal.attachCustomKeyEventHandler((event) => {
      const platform = isMacPlatform() ? "mac" : "linux";
      // Shift+Enter is a soft newline: a literal LF that does not submit the
      // line. xterm maps Enter to CR, so a bare Shift+Enter would submit just
      // like Enter; we rewrite it to ESC+CR, which TUI REPLs (Claude Code,
      // opencode, Codex) interpret as a multi-line continuation. For a plain
      // shell that ignores the ESC, the CR still ends the line — at worst the
      // shift key behaves like Enter. We swallow the event so xterm's own CR
      // send doesn't fire on top of ours.
      if (
        event.key === "Enter" &&
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        void ptyWrite(tab.id, "\x1b\r");
        return false;
      }
      // Native OS text-editing chords (Cmd+Delete, Option+arrows, etc.) map to
      // readline control characters so the shell does what the OS keybinding
      // promises. Handle these before app shortcuts so Cmd+Backspace in the
      // terminal deletes the line (Ctrl+U) instead of bubbling up to the
      // delete-file action.
      const sequence = nativeEditingSequence(event, platform);
      if (sequence !== null) {
        event.preventDefault();
        void ptyWrite(tab.id, sequence);
        return false;
      }
      // Let any configured Pragma shortcut bubble up to the window listener so
      // it works even when xterm has focus. The current config may be the
      // default or a user-edited `~/.pragma/keybindings.json`.
      if (actionForEvent(event, getKeybindingsConfig(), platform) !== null) {
        return false;
      }
      return true;
    });
    // Throttle wheel-driven mouse reports while a TUI is consuming them so a fast
    // trackpad flick can't flood the PTY input with reports it can't keep up with.
    // See MOUSE_WHEEL_REPORT_INTERVAL_MS. Returning false drops the event before
    // xterm turns it into a report; returning true forwards it verbatim.
    // Initialize to -Infinity so the first event after startup is always
    // forwarded when mouse tracking is on (performance.now() can still be < the
    // interval early in page life).
    let lastWheelReport = -Infinity;
    terminal.attachCustomWheelEventHandler(() => {
      if (terminal.modes.mouseTrackingMode === "none") {
        return true;
      }
      const now = performance.now();
      if (now - lastWheelReport < MOUSE_WHEEL_REPORT_INTERVAL_MS) {
        return false;
      }
      lastWheelReport = now;
      return true;
    });
    terminal.open(container);
    // GPU-accelerated rendering. xterm's default DOM renderer reflows real DOM
    // nodes on every frame, which is the dominant source of perceived typing
    // latency; the WebGL renderer paints cells to a canvas via the GPU and must
    // be loaded *after* open() so the canvas exists. If the WebGL context is
    // lost (driver reset, tab backgrounded too long) or unavailable (headless),
    // we dispose the addon and xterm transparently falls back to the DOM
    // renderer rather than freezing on a dead context.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
    } catch {
      // WebGL unavailable (e.g. headless CI); keep the DOM renderer.
    }

    const managed: ManagedTerminal = {
      terminal,
      fit,
      container,
      cwd,
      resizeTimer: null,
      lastResizeCols: null,
      lastResizeRows: null,
      pendingOutput: [],
      writeInFlight: false,
      channel: null,
    };
    this.terminals.set(tab.id, managed);
    terminal.onData((data) => void ptyWrite(tab.id, data));
    this.connect(tab, cwd, managed);
    this.fit(tab.id);
  }

  activate(tabId: string): void {
    window.requestAnimationFrame(() => this.fit(tabId));
  }

  clear(tabId: string): void {
    const managed = this.terminals.get(tabId);
    if (!managed) {
      return;
    }
    managed.terminal.clear();
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
    managed.pendingOutput = [];
    managed.writeInFlight = false;
    // Detach the channel handler so Tauri stops delivering events to a disposed
    // terminal, then tell the daemon to tear down the shell — without this the
    // shell process and its scrollback leak for the lifetime of the daemon.
    if (managed.channel) {
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri Channel exposes `onmessage` rather than EventTarget listeners.
      managed.channel.onmessage = () => {};
    }
    managed.terminal.dispose();
    managed.container.remove();
    this.terminals.delete(tabId);
    void ptyKill(tabId);
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
    if (dimensions.cols === cols && dimensions.rows === rows) {
      managed.fit.fit();
    } else if (managed.terminal.cols !== cols || managed.terminal.rows !== rows) {
      managed.terminal.resize(cols, rows);
    }
    const fittedCols = managed.terminal.cols;
    const fittedRows = managed.terminal.rows;
    if (managed.lastResizeCols === fittedCols && managed.lastResizeRows === fittedRows) {
      return;
    }
    managed.lastResizeCols = fittedCols;
    managed.lastResizeRows = fittedRows;
    void ptyResize(tabId, fittedCols, fittedRows);
  }

  private enqueueOutput(managed: ManagedTerminal, data: Uint8Array): void {
    managed.pendingOutput.push(data);
    if (!managed.writeInFlight) {
      this.flushOutput(managed);
    }
  }

  private flushOutput(managed: ManagedTerminal): void {
    const chunks = managed.pendingOutput;
    managed.pendingOutput = [];
    if (chunks.length === 0) {
      managed.writeInFlight = false;
      return;
    }
    // Coalesce the queued byte-chunks into a single write so a burst is one
    // parse/paint pass. xterm.write accepts bytes directly, so output never
    // becomes a JS string on this hot path.
    const data = chunks.length === 1 ? chunks[0]! : concatChunks(chunks);
    managed.writeInFlight = true;
    managed.terminal.write(data, () => {
      managed.writeInFlight = false;
      if (managed.pendingOutput.length > 0) {
        window.requestAnimationFrame(() => this.flushOutput(managed));
      }
    });
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

  private connect(tab: Tab, cwd: string, managed: ManagedTerminal): void {
    const tabId = tab.id;
    const onEvent = (message: PtyMessage) => {
      // Raw terminal output arrives as bytes (ArrayBuffer); control events as
      // JSON objects.
      if (message instanceof ArrayBuffer) {
        this.enqueueOutput(managed, new Uint8Array(message));
        return;
      }
      switch (message.event) {
        case "title": {
          const listeners = this.titleListeners.get(tabId);
          if (listeners) {
            for (const listener of listeners) {
              listener(message.title);
            }
          }
          break;
        }
        case "exit":
          managed.terminal.writeln(
            `\r\n[process exited${message.code === null ? "" : ` with ${message.code}`}]`,
          );
          break;
      }
    };
    const cols = managed.terminal.cols || 80;
    const rows = managed.terminal.rows || 24;
    ptyAttach(tabId, cols, rows, onEvent)
      .catch(() => ptySpawn(tabId, tab.worktreeId, cwd, cols, rows, onEvent))
      .then((channel) => {
        managed.channel = channel;
        // The remote session is brand new — either a fresh spawn, or an attach
        // that fell back to spawn after a daemon reset — and was created with the
        // pre-fit default size (80x24), because connect() runs before the first
        // fit(). The synchronous fit() in mount() may already have cached that
        // real size (and sent a resize to a session that did not exist yet), so
        // clear the cache to force fit() to re-send the current size now that the
        // session exists; otherwise it early-returns and the PTY stays at 80x24
        // while xterm fills the window.
        managed.lastResizeCols = null;
        managed.lastResizeRows = null;
        this.fit(tabId);
        return undefined;
      })
      .catch((error: unknown) => {
        managed.terminal.writeln(
          `\r\n[failed to start terminal: ${
            error instanceof Error ? error.message : String(error)
          }]`,
        );
      });
  }
}

/** Joins queued output byte-chunks into one contiguous buffer for a single write. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export const terminalManager = new TerminalManager();
