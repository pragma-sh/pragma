// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
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

  async *attach(sessionId: string, options: StreamOptions = {}): AsyncGenerator<SessionEvent> {
    const response = await this.transport.raw(routes.sessionEvents(sessionId), {
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

  killForCwd(cwd: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.transport.request<void>(`${routes.sessions}?cwd=${encodeURIComponent(cwd)}`, {
      method: "DELETE",
      signal: options.signal,
    });
  }
}
