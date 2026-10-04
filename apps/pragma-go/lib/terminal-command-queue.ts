import type { TerminalViewerCommand } from "@pragma-sh/terminal-viewer";

/**
 * How many commands are held while the document loads.
 *
 * A whole scrollback replay arrives as a handful of `output` commands, so this
 * is generous. The cap exists so a renderer that never reports `ready` — a web
 * view that failed to load — cannot grow without bound; past it the oldest
 * commands are dropped, which is what scrollback does anyway.
 */
export const TERMINAL_COMMAND_QUEUE_LIMIT = 512;

/** Holds renderer commands until the document can receive them. */
export interface TerminalCommandQueue {
  /** Delivers the command, or holds it until the renderer is ready. */
  send: (command: TerminalViewerCommand) => void;
  /** The renderer reported `ready`: flush what is held, in order. */
  ready: () => void;
  /** The document is (re)loading: hold again until the next `ready`. */
  reset: () => void;
}

/**
 * Buffers commands aimed at a terminal document that has not loaded yet.
 *
 * Both renderer twins push commands in one-way — `injectJavaScript` natively,
 * `postMessage` into a sandboxed frame on web — and both silently discard
 * anything sent before the document is live. That is not a rare race: attaching
 * to a session replays its whole retained scrollback immediately, and the web
 * view usually loses that footrace. A shell you then type into repaints itself
 * and hides the problem; a script's terminal, which nobody types into, just
 * stays black.
 *
 * So the ready signal the document already sends becomes the gate: commands
 * before it are held and flushed in order, commands after it go straight
 * through.
 */
export function createTerminalCommandQueue(
  deliver: (command: TerminalViewerCommand) => void,
): TerminalCommandQueue {
  let ready = false;
  let held: TerminalViewerCommand[] = [];

  return {
    send: (command) => {
      if (ready) {
        deliver(command);
        return;
      }
      held.push(command);
      if (held.length > TERMINAL_COMMAND_QUEUE_LIMIT) {
        held = held.slice(held.length - TERMINAL_COMMAND_QUEUE_LIMIT);
      }
    },
    ready: () => {
      ready = true;
      const pending = held;
      held = [];
      for (const command of pending) deliver(command);
    },
    reset: () => {
      ready = false;
      held = [];
    },
  };
}
