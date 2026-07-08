import type { ProtocolEventKind, WorkspaceSnapshot } from "@pragma/constants";

import { EventsClient, type ProtocolSubscriptionEvent } from "./events-client";

/** A workspace subscription event: a snapshot then full-replacement deltas. */
export type WorkspaceSubscriptionEvent =
  | { type: "snapshot"; subscription: ProtocolEventKind; payload: WorkspaceSnapshot }
  | { type: "delta"; subscription: ProtocolEventKind; payload: WorkspaceSnapshot };

/**
 * Typed workspace snapshot-then-delta subscription. v1 keeps deltas trivial:
 * every delta carries a full replacement snapshot. Delegates to the generic
 * {@link EventsClient} and narrows the payload to {@link WorkspaceSnapshot}.
 */
export class WorkspaceClient {
  constructor(private readonly events: EventsClient) {}

  async *subscribe(
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<WorkspaceSubscriptionEvent> {
    for await (const event of this.events.subscribe("workspace", options)) {
      yield this.narrow(event);
    }
  }

  private narrow(event: ProtocolSubscriptionEvent): WorkspaceSubscriptionEvent {
    return {
      type: event.type,
      subscription: event.subscription,
      payload: (event.payload ?? { projects: [], worktrees: [], tabs: [] }) as WorkspaceSnapshot,
    };
  }
}
