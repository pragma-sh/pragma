import { constants } from "@pragma/constants";
import { base64ToBytes, PragmaGatewayError, type SessionEvent } from "@pragma/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { useConnection } from "./connection-context";

/** How long to wait before retrying a dropped stream, and the ceiling. */
const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 10_000;

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

/** A live attachment to one host terminal session. */
export interface TerminalSession {
  status: TerminalStatus;
  /** Exit code once the shell has ended, when the host reported one. */
  exitCode: number | null;
  /** Why the session is unavailable, for a state the user can act on. */
  error: string | null;
  /** Sends raw bytes to the PTY. */
  write: (bytes: Uint8Array) => void;
  /** Reports the renderer's grid; applied only while this client holds the lease. */
  resize: (cols: number, rows: number) => void;
}

/**
 * Attaches to a host terminal session and holds its viewport while on screen.
 *
 * Three things make this different from a plain stream subscription:
 *
 * - **The grid is borrowed, not owned.** The desktop may be showing the same
 *   session, so the phone takes a viewport lease before resizing, renews it
 *   while attached, and releases it on the way out. If this app dies without
 *   releasing, the host expires the lease and restores the desktop's size.
 * - **A reconnect resumes, it does not replay.** The renderer keeps its screen
 *   across a dropped tunnel, so the stream reattaches from the last byte cursor
 *   it accepted and receives only what it missed — unless the host says the
 *   cursor is too old, in which case the renderer is reset first.
 * - **Input is never replayed.** A write that may or may not have arrived is
 *   not retried: resending a keystroke can run a command twice.
 */
export function useTerminalSession(
  sessionId: string | undefined,
  sink: TerminalSink,
  options: { attached: boolean },
): TerminalSession {
  const { client, handleUnauthorized } = useConnection();
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Refs, not state: output and cursor move far too often to re-render on, and
  // the lease has to be readable from callbacks that were created before it.
  const sinkRef = useRef(sink);
  sinkRef.current = sink;
  const cursor = useRef<number | null>(null);
  const lease = useRef<string | null>(null);
  const size = useRef<{ cols: number; rows: number } | null>(null);
  const attached = options.attached;

  useEffect(() => {
    if (!client || !sessionId || !attached) return undefined;
    // A mutable holder rather than a bare boolean: the cleanup below flips it
    // from outside the loop, which a plain variable makes invisible to readers
    // (and to the linter) at the point the loop tests it.
    const attachment = { live: true };
    const controller = new AbortController();
    let delay = RECONNECT_INITIAL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async (): Promise<void> => {
      while (attachment.live) {
        try {
          for await (const event of client.sessions.attach(sessionId, {
            signal: controller.signal,
            // The viewport travels with the attach only while this client owns
            // it; a size-less attach observes without disturbing the grid.
            ...(lease.current && size.current ? size.current : {}),
            ...(cursor.current === null ? {} : { cursor: cursor.current }),
          })) {
            if (!attachment.live) return;
            delay = RECONNECT_INITIAL_MS;
            applyEvent(event, cursor, sinkRef.current, setStatus, setExitCode);
          }
          // A stream that ends without an exit event is a dropped connection.
          if (!attachment.live) return;
        } catch (cause: unknown) {
          if (!attachment.live) return;
          if (cause instanceof PragmaGatewayError && cause.httpStatus === 401) {
            handleUnauthorized();
            return;
          }
          if (cause instanceof PragmaGatewayError && cause.httpStatus === 404) {
            setStatus("unavailable");
            setError("This terminal is no longer running on the host.");
            return;
          }
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        setStatus("connecting");
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delay);
        });
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      }
    };

    void run();
    return () => {
      attachment.live = false;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [attached, client, handleUnauthorized, sessionId]);

  // The lease: taken once the renderer has reported a grid, renewed while the
  // screen is up, released on the way out.
  useEffect(() => {
    if (!client || !sessionId || !attached) return undefined;
    let cancelled = false;
    let renew: ReturnType<typeof setInterval> | undefined;

    const acquire = async (): Promise<void> => {
      const grid = size.current;
      if (!grid) return;
      try {
        const granted = await client.sessions.acquireViewport(sessionId, grid);
        if (cancelled) {
          // Focus was lost while the request was in flight; hand it straight
          // back rather than leaving the desktop resized until expiry.
          void client.sessions.releaseViewport(sessionId, granted.leaseId).catch(() => undefined);
          return;
        }
        lease.current = granted.leaseId;
        renew = setInterval(() => {
          void client.sessions.renewViewport(sessionId, granted.leaseId).catch(() => undefined);
        }, constants.terminalViewport.renewIntervalMs);
      } catch {
        // Someone else holds the viewport, or the session ended. Neither stops
        // this client from reading the session at the size it is.
        lease.current = null;
      }
    };

    // The renderer measures itself after mount, so the first grid arrives a
    // frame or two late; retry until it does or the screen goes away.
    const poll = setInterval(() => {
      if (lease.current || !size.current) return;
      clearInterval(poll);
      void acquire();
    }, 50);

    return () => {
      cancelled = true;
      clearInterval(poll);
      if (renew !== undefined) clearInterval(renew);
      const held = lease.current;
      lease.current = null;
      if (held) {
        void client.sessions.releaseViewport(sessionId, held).catch(() => undefined);
      }
    };
  }, [attached, client, sessionId]);

  const write = useCallback(
    (bytes: Uint8Array) => {
      if (!client || !sessionId) return;
      // Deliberately not retried: a keystroke whose delivery is ambiguous can
      // run a command twice, and input is not idempotent.
      void client.sessions.write(sessionId, bytes).catch(() => undefined);
    },
    [client, sessionId],
  );

  const resize = useCallback(
    (cols: number, rows: number) => {
      size.current = { cols, rows };
      const held = lease.current;
      if (!client || !sessionId || !held) return;
      void client.sessions.resizeLeased(sessionId, { cols, rows }, held).catch(() => undefined);
    },
    [client, sessionId],
  );

  return { status, exitCode, error, write, resize };
}

/** Applies one stream event to the renderer and the connection state. */
function applyEvent(
  event: SessionEvent,
  cursor: { current: number | null },
  sink: TerminalSink,
  setStatus: (status: TerminalStatus) => void,
  setExitCode: (code: number | null) => void,
): void {
  switch (event.type) {
    case "replay":
      if (event.reset) {
        // The retained buffer no longer covers where this renderer was; its
        // screen is stale and the bytes that follow rebuild it.
        sink.onReset();
      }
      cursor.current = event.cursor;
      setStatus("live");
      break;
    case "output": {
      const at = cursor.current ?? 0;
      sink.onOutput(event.dataBase64, at);
      cursor.current = at + base64ToBytes(event.dataBase64).length;
      setStatus("live");
      break;
    }
    case "title":
      sink.onTitle?.(event.title);
      break;
    case "exit":
      setExitCode(event.code);
      setStatus("exited");
      break;
    case "echoMode":
      break;
  }
}
