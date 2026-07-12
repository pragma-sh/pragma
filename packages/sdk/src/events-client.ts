import type { ProtocolEventKind } from "@pragma/constants";

import { routes } from "./routes";
import { ndjsonStream } from "./streaming";
import type { Transport } from "./transport";

export type ProtocolSubscriptionEvent =
  | { type: "snapshot"; subscription: ProtocolEventKind; payload: unknown }
  | { type: "delta"; subscription: ProtocolEventKind; payload: unknown };

/** Protocol event subscription namespace. */
export class EventsClient {
  constructor(private readonly transport: Transport) {}

  async *subscribe(
    event: ProtocolEventKind,
    options: { cursor?: string; worktreeId?: string; cwd?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<ProtocolSubscriptionEvent> {
    const query = new URLSearchParams();
    if (options.cursor) {
      query.set("cursor", options.cursor);
    }
    if (options.worktreeId) {
      query.set("worktreeId", options.worktreeId);
    }
    if (options.cwd) {
      query.set("cwd", options.cwd);
    }
    const suffix = query.toString() ? `?${query}` : "";
    const response = await this.transport.raw(`${routes.subscription(event)}${suffix}`, {
      signal: options.signal,
    });
    for await (const line of ndjsonStream<{ type?: string }>(response, options.signal)) {
      // The gateway interleaves `{"type":"ready"}` keepalive lines with real
      // events; only snapshot/delta lines are subscription events.
      if (line.type === "snapshot" || line.type === "delta") {
        yield line as ProtocolSubscriptionEvent;
      }
    }
  }
}
