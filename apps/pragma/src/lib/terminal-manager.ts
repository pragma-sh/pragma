import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { Channel } from "@tauri-apps/api/core";

import type { Tab } from "@pragma/constants";

import { isMacPlatform } from "@/lib/platform";
import { ptyAttach, ptyKill, ptyResize, ptySpawn, ptyWrite, type PtyEvent } from "@/lib/tauri";

const RESIZE_DEBOUNCE_MS = 75;

interface ManagedTerminal {
  terminal: Terminal;
  fit: FitAddon;
  container: HTMLElement;
  cwd: string;
  resizeTimer: number | null;
  /** Live PTY event channel, retained so dispose() can detach its handler. */
  channel: Channel<PtyEvent> | null;
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
      if ((event.ctrlKey || event.altKey) && (event.key === "Tab" || /^[1-9]$/.test(event.key))) {
        return false;
      }
      // Let platform-specific close/new-tab/clear shortcuts bubble to the window
      // listener instead of being consumed by the terminal.
      const isMac = isMacPlatform();
      if (isMac && event.metaKey && (event.key === "w" || event.key === "t" || event.key === "k")) {
        return false;
      }
      if (
        !isMac &&
        event.ctrlKey &&
        (event.key === "w" || event.key === "t" || event.key === "k")
      ) {
        return false;
      }
      return true;
    });
    terminal.open(container);

    const managed: ManagedTerminal = {
      terminal,
      fit,
      container,
      cwd,
      resizeTimer: null,
      channel: null,
    };
    this.terminals.set(tab.id, managed);
    terminal.onData((data) => void ptyWrite(tab.id, data));
    this.connect(tab.id, cwd, managed);
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
    managed.fit.fit();
    const { cols, rows } = managed.terminal;
    void ptyResize(tabId, cols, rows);
  }

  private connect(tabId: string, cwd: string, managed: ManagedTerminal): void {
    const onEvent = (event: PtyEvent) => {
      if (event.event === "output") {
        managed.terminal.write(event.data);
      } else {
        managed.terminal.writeln(
          `\r\n[process exited${event.code === null ? "" : ` with ${event.code}`}]`,
        );
      }
    };
    const cols = managed.terminal.cols || 80;
    const rows = managed.terminal.rows || 24;
    ptyAttach(tabId, cols, rows, onEvent)
      .catch(() => ptySpawn(tabId, cwd, cols, rows, onEvent))
      .then((channel) => {
        managed.channel = channel;
        // Sync the remote PTY to the laid-out size now that the session exists.
        this.fit(tabId);
        return undefined;
      })
      .catch((error: unknown) => {
        managed.terminal.writeln(
          `\r\n[failed to start terminal: ${error instanceof Error ? error.message : String(error)}]`,
        );
      });
  }
}

export const terminalManager = new TerminalManager();
