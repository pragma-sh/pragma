/**
 * The message protocol between a native client and the terminal document it
 * embeds.
 *
 * Both directions are one-way JSON over a string bridge (a React Native web
 * view, or a sandboxed `<iframe>` on the web), so every payload here has to
 * survive `JSON.stringify` and arrive as untrusted text. The renderer accepts
 * only the commands below and sends only the messages below; anything else is
 * dropped rather than interpreted.
 */

/** Sent by the host into the renderer. */
export type TerminalViewerCommand =
  /**
   * Terminal output to write, base64 of the raw bytes.
   *
   * Base64, not a string: terminal output is bytes, and a multi-byte character
   * split across two chunks would be mangled by decoding each half on its own.
   * The renderer decodes into xterm's own byte-aware writer, which joins them.
   */
  | { type: "write"; dataBase64: string; cursor?: number }
  /**
   * Clears the screen and scrollback before the next write.
   *
   * Sent when the host's replay cursor fell outside retained scrollback: the
   * bytes that follow rebuild the screen rather than continuing it, and
   * appending them to a stale screen would interleave two states.
   */
  | { type: "reset" }
  /** Re-measures the element and reports the resulting grid back as `resize`. */
  | { type: "fit" }
  /** Moves keyboard focus into the terminal. */
  | { type: "focus" }
  /** Scrolls to the live edge. */
  | { type: "scrollToBottom" }
  /** Replaces the theme's CSS custom properties. */
  | { type: "theme"; css: string; mode: "light" | "dark" }
  /**
   * Writes text as if pasted, honouring the program's bracketed-paste mode.
   *
   * A paste is not the same as typing the characters: a shell in bracketed
   * paste treats the wrapped text as literal input rather than as commands to
   * run, which is exactly what stops a multi-line paste from executing itself.
   */
  | { type: "paste"; text: string }
  /** Marks the session as finished; the renderer stops accepting input. */
  | { type: "exit"; code: number | null };

/** Sent by the renderer back to the host. */
export type TerminalViewerMessage =
  /** The renderer has mounted and is ready for commands. */
  | { type: "ready" }
  /** User input, base64 of the raw bytes to write to the PTY. */
  | { type: "input"; dataBase64: string }
  /** The grid the renderer now occupies, after a fit or a font change. */
  | { type: "resize"; cols: number; rows: number }
  /**
   * Bytes handed to the parser have been processed.
   *
   * The host uses this as backpressure: a phone that cannot parse as fast as
   * the host can send must not accumulate an unbounded queue of pending writes.
   */
  | { type: "written"; bytes: number }
  /** The user activated a link in the terminal output. */
  | { type: "link"; url: string }
  /** Whether the user has scrolled away from the live edge. */
  | { type: "scroll"; atBottom: boolean };

/**
 * Narrows an untrusted parsed value to a command.
 *
 * The renderer runs whatever the bridge hands it, so this is a boundary check,
 * not a convenience: an unrecognised shape is discarded rather than partially
 * applied.
 */
export function isTerminalViewerCommand(value: unknown): value is TerminalViewerCommand {
  if (typeof value !== "object" || value === null) return false;
  const command = value as { type?: unknown };
  switch (command.type) {
    case "write":
      return typeof (value as { dataBase64?: unknown }).dataBase64 === "string";
    case "paste":
      return typeof (value as { text?: unknown }).text === "string";
    case "theme":
      return typeof (value as { css?: unknown }).css === "string";
    case "exit":
    case "reset":
    case "fit":
    case "focus":
    case "scrollToBottom":
      return true;
    default:
      return false;
  }
}

/** Narrows an untrusted parsed value to a renderer message. */
export function isTerminalViewerMessage(value: unknown): value is TerminalViewerMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { type?: unknown };
  switch (message.type) {
    case "input":
      return typeof (value as { dataBase64?: unknown }).dataBase64 === "string";
    case "resize":
      return (
        typeof (value as { cols?: unknown }).cols === "number" &&
        typeof (value as { rows?: unknown }).rows === "number"
      );
    case "written":
      return typeof (value as { bytes?: unknown }).bytes === "number";
    case "link":
      return typeof (value as { url?: unknown }).url === "string";
    case "scroll":
      return typeof (value as { atBottom?: unknown }).atBottom === "boolean";
    case "ready":
      return true;
    default:
      return false;
  }
}

/** Parses a bridge payload into a message, or null when it is not one. */
export function parseTerminalViewerMessage(raw: string): TerminalViewerMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isTerminalViewerMessage(value) ? value : null;
  } catch {
    return null;
  }
}
