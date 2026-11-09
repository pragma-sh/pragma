import type { ProtocolEventKind } from "@pragma-sh/constants";

import { routes } from "./routes";
import { type EventTypes, typedEventStream } from "./streaming";
import type { Transport } from "./transport";

export type ProtocolSubscriptionEvent =
  | { type: "snapshot"; subscription: ProtocolEventKind; payload: unknown }
  | { type: "delta"; subscription: ProtocolEventKind; payload: unknown };

/** Only snapshot/delta lines are subscription events; keepalives are dropped. */
const SUBSCRIPTION_EVENT_TYPES: EventTypes<ProtocolSubscriptionEvent> = {
  snapshot: true,
  delta: true,
};

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
      localOnly: event === "computerActivity",
    });
    yield* typedEventStream<ProtocolSubscriptionEvent>(
      response,
      SUBSCRIPTION_EVENT_TYPES,
      options.signal,
    );
  }
}
