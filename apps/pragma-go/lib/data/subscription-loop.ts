import { PragmaGatewayError } from "@pragma-sh/sdk";

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** A connection that lived this long counts as healthy: reset the backoff. */
const RECONNECT_HEALTHY_MS = 30_000;

function isUnauthorized(error: unknown): boolean {
  return error instanceof PragmaGatewayError && error.httpStatus === 401;
}

/**
 * Retries `body` with exponential backoff until the signal aborts.
 *
 * Every long-lived host stream on the phone (workspace, agent status, fanouts)
 * runs through this one loop, so they all recover from tunnel drops the same
 * way. A 401 stops the loop and reports it: the token is gone, and retrying
 * would only hammer the host.
 */
export async function subscriptionLoop(
  signal: AbortSignal,
  onUnauthorized: () => void,
  body: (onDelivered: () => void) => Promise<void>,
): Promise<void> {
  let backoff = RECONNECT_INITIAL_MS;
  while (!signal.aborted) {
    // Sequential on purpose: a reconnect must not overlap the attempt before
    // it, and each attempt's backoff depends on how the previous one ended.
    // oxlint-disable-next-line no-await-in-loop -- sequential reconnect attempts.
    const result = await runSubscription(body);
    if (result === "unauthorized") {
      onUnauthorized();
      return;
    }
    if (signal.aborted) return;
    backoff = reconnectDelay(backoff, result);
    // oxlint-disable-next-line no-await-in-loop -- backoff between reconnects.
    await delay(backoff, signal);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }
}

async function runSubscription(
  body: (onDelivered: () => void) => Promise<void>,
): Promise<{ startedAt: number; delivered: boolean } | "unauthorized"> {
  const startedAt = Date.now();
  let delivered = false;
  try {
    await body(() => {
      delivered = true;
    });
  } catch (error) {
    if (isUnauthorized(error)) return "unauthorized";
  }
  return { startedAt, delivered };
}

function reconnectDelay(
  backoff: number,
  result: { startedAt: number; delivered: boolean },
): number {
  // Streams routinely die after tunnel idle. A connection that delivered data —
  // or simply lived a long time — is healthy, so reconnect promptly instead of
  // carrying a large backoff across its lifetime.
  if (result.delivered || Date.now() - result.startedAt >= RECONNECT_HEALTHY_MS) {
    return RECONNECT_INITIAL_MS;
  }
  return backoff;
}

/**
 * Sleeps for `ms`, or until the signal aborts. The abort listener is removed
 * when the timer wins: this runs once per reconnect for the app's lifetime, so
 * leaving one listener per attempt would accumulate on the shared signal.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  // One resolve per settling promise, raced; whichever loses is torn down in
  // `finally`, so the shared signal never accumulates an abort listener per
  // reconnect.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([timeout, aborted]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  });
}
