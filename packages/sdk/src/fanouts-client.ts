// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
import type {
  Fanout,
  FanoutCreateRequest,
  FanoutMemberRequest,
  FanoutPickResult,
  FanoutReadRequest,
  FanoutReadTarget,
  FanoutRef,
  FanoutResult,
  FanoutSendRequest,
  FanoutSendResult,
  FanoutSubscriptionPayload,
  ProtocolEventKind,
} from "@pragma/constants";

import { base64ToBytes } from "./encoding";
import type { EventsClient, ProtocolSubscriptionEvent } from "./events-client";
import { routes } from "./routes";
import type { Transport } from "./transport";

/** Options accepted by every fanout call. */
export interface FanoutRequestOptions {
  signal?: AbortSignal;
}

/** One member's terminal output, with the base64 wire field decoded. */
export interface FanoutReadTargetBytes extends Omit<FanoutReadTarget, "data"> {
  /** The same window as raw bytes. Callers never see the base64 wire form. */
  raw: Uint8Array;
}

/** A read result whose targets carry decoded bytes. */
export interface FanoutReadResultBytes {
  fanoutId: string;
  targets: FanoutReadTargetBytes[];
}

/** A fanout subscription event: a snapshot then full-replacement deltas. */
export type FanoutSubscriptionEvent =
  | { type: "snapshot"; subscription: ProtocolEventKind; payload: FanoutSubscriptionPayload }
  | { type: "delta"; subscription: ProtocolEventKind; payload: FanoutSubscriptionPayload };

/**
 * Fanout orchestration: launching one prompt into several isolated attempts,
 * following them, and finally picking one.
 *
 * Every method goes through the local gateway to the host that owns the
 * project — the same `fanouts` RPC `pragma-cli` uses — so a fanout behaves
 * identically whether it was started from a terminal, from the desktop, or from
 * a script, and whether or not the desktop app is running.
 */
export class FanoutsClient {
  constructor(
    private readonly transport: Transport,
    private readonly events: EventsClient,
  ) {}

  /**
   * Provisions a whole fanout: the parent, one worktree per attempt branched
   * from one captured commit, and one agent-owned terminal tab in each.
   *
   * Resolves once every attempt has launched or failed. A partly-provisioned
   * fanout resolves rather than throwing — `partial` is true and `failures`
   * names the members to retry — because the healthy attempts are real and
   * already running.
   */
  create(request: FanoutCreateRequest, options: FanoutRequestOptions = {}): Promise<FanoutResult> {
    return this.rpc("create", request, options);
  }

  /** Reads one fanout by id, or by any worktree that belongs to it. */
  get(reference: FanoutRef, options: FanoutRequestOptions = {}): Promise<Fanout> {
    return this.rpc("get", reference, options);
  }

  /**
   * Bounded terminal output for one member (`memberId`) or every member
   * (`all: true`). The raw bytes arrive base64-encoded and are decoded here, so
   * callers see a `Uint8Array` and never the wire form.
   */
  async read(
    request: FanoutReadRequest,
    options: FanoutRequestOptions = {},
  ): Promise<FanoutReadResultBytes> {
    const result = await this.rpc<{ fanoutId: string; targets: FanoutReadTarget[] }>(
      "read",
      request,
      options,
    );
    return {
      fanoutId: result.fanoutId,
      targets: result.targets.map(({ data, ...target }) => ({
        ...target,
        raw: base64ToBytes(data),
      })),
    };
  }

  /**
   * Delivers a follow-up to one member or to every live member.
   *
   * Waits for per-member delivery receipts unless `waitForDelivery` is false.
   * Passing the same `messageId` twice is safe: a member that already took the
   * message is not typed into again.
   */
  send(request: FanoutSendRequest, options: FanoutRequestOptions = {}): Promise<FanoutSendResult> {
    return this.rpc("send", request, options);
  }

  /**
   * Relaunches one member's agent in its existing worktree. The worktree is
   * reused deliberately — it may already hold work — and the previous tab moves
   * into the member's history.
   */
  retry(request: FanoutMemberRequest, options: FanoutRequestOptions = {}): Promise<FanoutResult> {
    return this.rpc("retry", request, options);
  }

  /** Stops every attempt and releases the parent. Checkouts are kept. */
  cancel(reference: FanoutRef, options: FanoutRequestOptions = {}): Promise<FanoutResult> {
    return this.rpc("cancel", reference, options);
  }

  /**
   * **Destructive.** Commits the winner's uncommitted work under an
   * AI-generated message, merges it into the parent, promotes its scratchpads,
   * and then deletes every attempt worktree and branch — the winner included.
   *
   * There is deliberately no confirmation flag here: confirming is the UI's and
   * the CLI's job. A merge conflict or a failed cleanup resolves with the
   * durable fanout and a `stage` to resume from rather than throwing.
   */
  pick(
    request: FanoutMemberRequest,
    options: FanoutRequestOptions = {},
  ): Promise<FanoutPickResult> {
    return this.rpc("pick", request, options);
  }

  /**
   * Typed fanout snapshot-then-delta subscription. v1 keeps deltas trivial:
   * every delta carries the host's full fanout set.
   */
  async *subscribe(
    options: { fanoutId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<FanoutSubscriptionEvent> {
    for await (const event of this.events.subscribe("fanouts", { signal: options.signal })) {
      const narrowed = this.narrow(event);
      if (!options.fanoutId) {
        yield narrowed;
        continue;
      }
      // Filtering client-side keeps the host's stream a single broadcast; the
      // payload is a full replacement either way.
      yield {
        ...narrowed,
        payload: {
          fanouts: narrowed.payload.fanouts.filter((fanout) => fanout.id === options.fanoutId),
        },
      };
    }
  }

  private narrow(event: ProtocolSubscriptionEvent): FanoutSubscriptionEvent {
    return {
      type: event.type,
      subscription: event.subscription,
      payload: (event.payload ?? { fanouts: [] }) as FanoutSubscriptionPayload,
    };
  }

  private rpc<T>(action: string, payload: unknown, options: FanoutRequestOptions): Promise<T> {
    return this.transport.request<T>(routes.rpc("fanouts"), {
      method: "POST",
      body: { action, ...(payload as Record<string, unknown>) },
      signal: options.signal,
    });
  }
}
