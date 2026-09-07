// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
import type { SessionInfo, ViewportLease } from "@pragma/constants";

import { routes } from "./routes";
import { ndjsonStream } from "./streaming";
import type { Transport } from "./transport";
import type {
  SessionEvent,
  SpawnSessionRequest,
  SpawnSessionResponse,
  StreamOptions,
} from "./types/sessions";

/** PTY session gateway namespace. */
export class SessionsClient {
  constructor(private readonly transport: Transport) {}

  spawn(
    payload: SpawnSessionRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<SpawnSessionResponse> {
    return this.transport.request<SpawnSessionResponse>(routes.sessions, {
      method: "POST",
      body: payload,
      signal: options.signal,
    });
  }

  /**
   * Attaches to a session's event stream.
   *
   * The first event is always a `replay`, naming the byte cursor output starts
   * at and whether the client must reset. Pass `cursor` to resume a stream this
   * same renderer was reading; pass `cols`/`rows` only when this client owns
   * the viewport, since attaching with a size resizes the shared PTY.
   */
  async *attach(sessionId: string, options: StreamOptions = {}): AsyncGenerator<SessionEvent> {
    const response = await this.transport.raw(attachRoute(sessionId, options), {
      signal: options.signal,
    });
    yield* ndjsonStream<SessionEvent>(response, options.signal);
  }

  write(
    sessionId: string,
    bytes: Uint8Array,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.transport.request<void>(routes.sessionInput(sessionId), {
      method: "POST",
      rawBody: bytes,
      headers: { "content-type": "application/octet-stream" },
      signal: options.signal,
    });
  }

  resize(
    sessionId: string,
    payload: { cols: number; rows: number },
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.transport.request<void>(routes.sessionResize(sessionId), {
      method: "POST",
      body: payload,
      signal: options.signal,
    });
  }

  kill(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.transport.request<void>(routes.session(sessionId), {
      method: "DELETE",
      signal: options.signal,
    });
  }

  /** Renames the workspace tab associated with a session. */
  rename(sessionId: string, title: string): Promise<void> {
    return this.transport.request<void>(routes.control("tabRename"), {
      method: "POST",
      body: { tabId: sessionId, title },
    });
  }

  /** Reports a session's grid, liveness, and whether its viewport is leased. */
  info(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<SessionInfo> {
    return this.sessionsRpc<SessionInfo>({ action: "info", sessionId }, options);
  }

  /**
   * Takes temporary exclusive ownership of a session's PTY grid and resizes it.
   *
   * A session's grid is shared with every other client showing it, so a small
   * client cannot simply resize it to fit. The lease makes that borrowing
   * explicit and time-bounded: renew it while the terminal is on screen, and
   * release it when leaving. If this client vanishes without releasing, the
   * host expires the lease and restores the previous size on its own.
   */
  acquireViewport(
    sessionId: string,
    size: { cols: number; rows: number },
    options: { signal?: AbortSignal } = {},
  ): Promise<ViewportLease> {
    return this.sessionsRpc<ViewportLease>(
      { action: "acquireViewport", sessionId, cols: size.cols, rows: size.rows },
      options,
    );
  }

  /** Extends a held lease. Renew well inside `expiresInMs`. */
  async renewViewport(
    sessionId: string,
    leaseId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.sessionsRpc({ action: "renewViewport", sessionId, leaseId }, options);
  }

  /** Hands the grid back and restores the size its owner last wanted. */
  async releaseViewport(
    sessionId: string,
    leaseId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.sessionsRpc({ action: "releaseViewport", sessionId, leaseId }, options);
  }

  /**
   * Resizes while holding a lease. Returns whether the host applied it: a
   * resize sent without the current lease is recorded as the size to restore
   * later, not applied, so the client holding the terminal keeps its grid.
   */
  async resizeLeased(
    sessionId: string,
    size: { cols: number; rows: number },
    leaseId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const result = await this.sessionsRpc<{ applied: boolean }>(
      { action: "resize", sessionId, cols: size.cols, rows: size.rows, leaseId },
      options,
    );
    return result.applied;
  }

  private sessionsRpc<T>(body: unknown, options: { signal?: AbortSignal }): Promise<T> {
    return this.transport.request<T>(routes.rpc("sessions"), {
      method: "POST",
      body,
      signal: options.signal,
    });
  }

  killForCwd(cwd: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.transport.request<void>(`${routes.sessions}?cwd=${encodeURIComponent(cwd)}`, {
      method: "DELETE",
      signal: options.signal,
    });
  }
}

/** Builds the attach URL, carrying only the options the caller actually set. */
function attachRoute(sessionId: string, options: StreamOptions): string {
  const query = new URLSearchParams();
  if (options.cols !== undefined && options.rows !== undefined) {
    query.set("cols", String(options.cols));
    query.set("rows", String(options.rows));
  }
  if (options.cursor !== undefined) {
    query.set("cursor", String(options.cursor));
  }
  const suffix = query.toString();
  return suffix ? `${routes.sessionEvents(sessionId)}?${suffix}` : routes.sessionEvents(sessionId);
}
