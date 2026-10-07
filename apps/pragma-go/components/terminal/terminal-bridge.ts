import { parseTerminalViewerMessage, type TerminalViewerMessage } from "@pragma-sh/terminal-viewer";

/** What the terminal screen wants back from the renderer, on either platform. */
export interface TerminalViewProps {
  /** The renderer mounted and is ready for commands. */
  onReady: () => void;
  /** The user typed; `dataBase64` is the raw bytes to send to the PTY. */
  onInput: (dataBase64: string) => void;
  /** The renderer measured itself; this is the grid it now occupies. */
  onResize: (cols: number, rows: number) => void;
  /** The parser finished with this many bytes — the host's backpressure signal. */
  onWritten?: (bytes: number) => void;
  /** The user activated a link in the output. */
  onLink?: (url: string) => void;
  /** Whether the view is scrolled to the live edge. */
  onScroll?: (atBottom: boolean) => void;
}

/**
 * Routes one raw bridge payload to the prop that owns it.
 *
 * Shared by both platform twins so the native web view and the web build agree
 * on the protocol. Anything unrecognised is dropped: a sandboxed frame receives
 * whatever else on the page posts to it, and a native bridge is just as
 * untrusted.
 */
export function terminalMessageHandler(props: TerminalViewProps): (raw: string) => void {
  return (raw: string) => {
    const message = parseTerminalViewerMessage(raw);
    if (!message) return;
    const route = MESSAGE_ROUTES[message.type] as (
      message: TerminalViewerMessage,
      props: TerminalViewProps,
    ) => void;
    route(message, props);
  };
}

type MessageOf<T extends TerminalViewerMessage["type"]> = Extract<
  TerminalViewerMessage,
  { type: T }
>;

/** Which prop each renderer message is delivered to. */
const MESSAGE_ROUTES: {
  [T in TerminalViewerMessage["type"]]: (message: MessageOf<T>, props: TerminalViewProps) => void;
} = {
  ready: (_message, props) => props.onReady(),
  input: (message, props) => props.onInput(message.dataBase64),
  resize: (message, props) => props.onResize(message.cols, message.rows),
  written: (message, props) => props.onWritten?.(message.bytes),
  link: (message, props) => props.onLink?.(message.url),
  scroll: (message, props) => props.onScroll?.(message.atBottom),
};
