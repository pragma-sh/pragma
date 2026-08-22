import { PragmaGatewayError } from "@pragma/sdk";
import type { GatewayHealth, PragmaClient } from "@pragma/sdk";
import { describe, expect, it } from "vitest";

import { checkHeartbeat, heartbeatFailure, heartbeatSummary } from "./heartbeat";

const health: GatewayHealth = { status: "ok", protocolVersion: "0.0.0", gatewayVersion: "0.4.1" };

function clientReturning(result: Promise<GatewayHealth>): PragmaClient {
  return { health: { check: () => result } } as unknown as PragmaClient;
}

describe("heartbeatFailure", () => {
  it("names a timeout as the host not answering", () => {
    expect(heartbeatFailure(new Error("aborted"), true).kind).toBe("failed");
    expect(heartbeatSummary(heartbeatFailure(new Error("aborted"), true))).toContain("in time");
  });

  it("tells a rejected token apart from an unreachable host", () => {
    const rejected = new PragmaGatewayError("nope", { code: "unauthorized", httpStatus: 401 });
    expect(heartbeatSummary(heartbeatFailure(rejected, false))).toContain("Pair again");
    expect(heartbeatSummary(heartbeatFailure(new Error("boom"), false))).toContain(
      "Couldn't reach",
    );
  });
});

describe("heartbeatSummary", () => {
  it("has nothing to say before the first check", () => {
    expect(heartbeatSummary({ kind: "idle" })).toBeNull();
    expect(heartbeatSummary({ kind: "checking" })).toBe("Checking…");
  });

  it("reports status, latency, and both versions", () => {
    const summary = heartbeatSummary({ kind: "ok", latencyMs: 42, health });
    expect(summary).toBe("ok · 42 ms · gateway 0.4.1 · protocol v3");
  });
});

describe("checkHeartbeat", () => {
  it("resolves to the health body on success", async () => {
    const state = await checkHeartbeat(clientReturning(Promise.resolve(health)));
    expect(state).toMatchObject({ kind: "ok", health });
  });

  it("resolves to a failure rather than throwing", async () => {
    const state = await checkHeartbeat(clientReturning(Promise.reject(new Error("down"))));
    expect(state.kind).toBe("failed");
  });
});
