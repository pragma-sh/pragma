import { PragmaGatewayError } from "@pragma/sdk";
import { describe, expect, it, vi } from "vitest";

import { waitForExit } from "./session-attach";

describe("waitForExit", () => {
  it("retries when the watcher starts before the session exists", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let attaches = 0;
    const sdk = {
      sessions: {
        attach: async function* () {
          attaches += 1;
          if (attaches === 1) {
            throw new PragmaGatewayError("session not found", {
              code: "notFound",
              httpStatus: 404,
            });
          }
          yield { type: "exit", code: 0 };
        },
      },
    };

    const waiting = waitForExit(sdk as never, "tab-1", controller.signal);
    await vi.advanceTimersByTimeAsync(250);
    await waiting;

    expect(attaches).toBe(2);
    vi.useRealTimers();
  });
});
