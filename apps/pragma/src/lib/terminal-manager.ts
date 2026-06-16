import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { Channel } from "@tauri-apps/api/core";

import type { Tab } from "@pragma/constants";

import { actionForEvent, getKeybindingsConfig } from "@/lib/keybindings";
import { isMacPlatform } from "@/lib/platform";
import { ptyAttach, ptyKill, ptyResize, ptySpawn, ptyWrite, type PtyEvent } from "@/lib/tauri";

const RESIZE_DEBOUNCE_MS = 75;

export type TitleListener = (title: string) => void;

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
      // Let any configured Pragma shortcut bubble up to the window listener so it
      // works even when xterm has focus. The current config may be the default or
      // a user-edited `~/.pragma/keybindings.json`.
      const platform = isMacPlatform() ? "mac" : "linux";
      if (actionForEvent(event, getKeybindingsConfig(), platform) !== null) {
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

  private connect(tabId: string, cwd: string, managed: ManagedTerminal): void {
    const onEvent = (event: PtyEvent) => {
      switch (event.event) {
        case "output":
          managed.terminal.write(event.data);
          break;
        case "title": {
          const listeners = this.titleListeners.get(tabId);
          if (listeners) {
            for (const listener of listeners) {
              listener(event.title);
            }
          }
          break;
        }
        case "exit":
          managed.terminal.writeln(
            `\r\n[process exited${event.code === null ? "" : ` with ${event.code}`}]`,
          );
          break;
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
