import { PragmaGatewayError } from "@pragma-sh/sdk";
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { subscriptionLoop } from "./subscription-loop";

const unauthorized = () =>
  new PragmaGatewayError("unauthorized", { code: "unauthorized", httpStatus: 401 });

describe("subscriptionLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects a healthy stream at the initial delay and stops on abort", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let attempts = 0;
    const loop = subscriptionLoop(
      controller.signal,
      () => {},
      async (onDelivered) => {
        attempts += 1;
        if (attempts === 1) {
          onDelivered();
          return;
        }
        controller.abort();
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);

    // A stream that delivered is healthy, so the next attempt starts at the
    // initial delay rather than whatever backoff had accumulated.
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toBe(2);

    await loop;
    expect(controller.signal.aborted).toBe(true);
  });

  it("grows the backoff while attempts keep failing without delivering", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let attempts = 0;
    const loop = subscriptionLoop(
      controller.signal,
      () => {},
      async () => {
        attempts += 1;
        if (attempts === 3) controller.abort();
        throw new Error("tunnel down");
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);

    await loop;
  });

  it("stops and reports a 401 without retrying", async () => {
    const controller = new AbortController();
    const onUnauthorized = vi.fn();
    let attempts = 0;

    await subscriptionLoop(controller.signal, onUnauthorized, async () => {
      attempts += 1;
      throw unauthorized();
    });

    expect(attempts).toBe(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("wakes from the backoff wait as soon as the signal aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let attempts = 0;
    const loop = subscriptionLoop(
      controller.signal,
      () => {},
      async () => {
        attempts += 1;
        throw new Error("tunnel down");
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await loop;
    expect(attempts).toBe(1);
  });

  it("removes its abort listener when the backoff timer wins", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let attempts = 0;
    const loop = subscriptionLoop(
      controller.signal,
      () => {},
      async () => {
        attempts += 1;
        throw new Error("tunnel down");
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

    // The 500ms timer from the first failure fires (starting attempt 2); its
    // listener must be gone rather than accumulating across reconnects.
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await loop;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
