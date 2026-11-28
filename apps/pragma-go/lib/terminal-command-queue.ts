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
  /**
   * The renderer reported `ready`: flush what is held, in order.
   *
   * Returns whether this document missed output — commands that went to a
   * document it replaced, or that were discarded while it loaded. Its screen is
   * then incomplete and nothing already sent will fill it in, so the caller has
   * to ask the session for its scrollback again.
   */
  ready: () => boolean;
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
 *
 * A document can also be *replaced* — a new palette rebuilds it, and iOS
 * discards a backgrounded web view's content process — and the replacement
 * starts with an empty screen. The session stream has no idea: it resumes from
 * its byte cursor and sends only what is new, so the terminal stayed blank
 * until the program happened to repaint. `ready` therefore reports when the
 * document it just opened missed output, so the caller can replay.
 */
export function createTerminalCommandQueue(
  deliver: (command: TerminalViewerCommand) => void,
): TerminalCommandQueue {
  let ready = false;
  let held: TerminalViewerCommand[] = [];
  // Whether the current document has been sent anything, and whether a reset
  // threw output away. Together they answer "is the next document's screen
  // missing what the session already produced?".
  let delivered = false;
  let missed = false;

  return {
    send: (command) => {
      if (ready) {
        delivered = true;
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
      if (pending.length > 0) delivered = true;
      for (const command of pending) deliver(command);
      const incomplete = missed;
      missed = false;
      return incomplete;
    },
    reset: () => {
      // Whatever the outgoing document was sent, and whatever was waiting for
      // it, is gone with it.
      if (delivered || held.length > 0) missed = true;
      delivered = false;
      ready = false;
      held = [];
    },
  };
}
