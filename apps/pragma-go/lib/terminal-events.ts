import { base64ToBytes, type SessionEvent } from "@pragma-sh/sdk";

/** What the terminal screen knows about its session. */
export type TerminalStatus = "connecting" | "live" | "exited" | "unavailable";

/** Callbacks the renderer supplies, so output never passes through React state. */
export interface TerminalSink {
  /** Write terminal output. `cursor` is the absolute byte offset it starts at. */
  onOutput: (dataBase64: string, cursor: number) => void;
  /** Clear and rebuild: the resume cursor fell outside retained scrollback. */
  onReset: () => void;
  /** The shell reported a new window title. */
  onTitle?: (title: string) => void;
}

/** Where stream events land: the renderer, the resume cursor, and React state. */
export interface StreamTarget {
  cursor: { current: number | null };
  sink: TerminalSink;
  setStatus: (status: TerminalStatus) => void;
  setExitCode: (code: number | null) => void;
}

type EventOf<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;

const EVENT_HANDLERS: {
  [T in SessionEvent["type"]]: (event: EventOf<T>, target: StreamTarget) => void;
} = {
  replay: (event, { cursor, sink, setStatus }) => {
    // A reset means the retained buffer no longer covers where this renderer
    // was; its screen is stale and the bytes that follow rebuild it.
    if (event.reset) sink.onReset();
    cursor.current = event.cursor;
    setStatus("live");
  },
  output: (event, { cursor, sink, setStatus }) => {
    const at = cursor.current ?? 0;
    sink.onOutput(event.dataBase64, at);
    cursor.current = at + base64ToBytes(event.dataBase64).length;
    setStatus("live");
  },
  title: (event, { sink }) => sink.onTitle?.(event.title),
  exit: (event, { setStatus, setExitCode }) => {
    setExitCode(event.code);
    setStatus("exited");
  },
  echoMode: () => undefined,
};

/**
 * Applies one stream event to the renderer and the connection state.
 *
 * The SDK already drops gateway keepalives and unknown types, but this is the
 * last line before a dispatch that would throw — an older SDK, or a host that
 * adds an event type, must never wedge the terminal at "Connecting…". So an
 * event whose `type` names no handler of this map's own is ignored, never
 * looked up on the prototype or called.
 */
export function applyTerminalEvent(event: { type: string }, target: StreamTarget): void {
  if (!Object.prototype.hasOwnProperty.call(EVENT_HANDLERS, event.type)) return;
  const handler = EVENT_HANDLERS[event.type as SessionEvent["type"]] as (
    event: SessionEvent,
    target: StreamTarget,
  ) => void;
  handler(event as SessionEvent, target);
}
