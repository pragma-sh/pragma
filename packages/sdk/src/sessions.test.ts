import { describe, expect, it } from "vitest";

import { PragmaClient } from "./client";

/** A gateway that answers the attach with these NDJSON lines. */
function streaming(lines: unknown[]): PragmaClient {
  const body = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  return new PragmaClient({
    baseUrl: "http://127.0.0.1:1",
    token: "token",
    fetch: async () => new Response(body, { headers: { "content-type": "application/x-ndjson" } }),
  });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

describe("client.sessions.attach", () => {
  it("drops gateway keepalives and unknown event types", async () => {
    const replay = { type: "replay", sessionId: "s1", cursor: 0, reset: false };
    const output = { type: "output", sessionId: "s1", dataBase64: "aGk=" };
    const sdk = streaming([
      { type: "ready" },
      replay,
      { type: "ready" },
      output,
      { type: "somethingNew" },
      { type: "constructor" },
      { noType: true },
    ]);

    expect(await collect(sdk.sessions.attach("s1"))).toEqual([replay, output]);
  });
});

describe("client.events.subscribe", () => {
  it("still yields only snapshot and delta lines", async () => {
    const snapshot = { type: "snapshot", subscription: "agentStatus", payload: [] };
    const delta = { type: "delta", subscription: "agentStatus", payload: {} };
    const sdk = streaming([{ type: "ready" }, snapshot, { type: "ready" }, delta]);

    expect(await collect(sdk.events.subscribe("agentStatus"))).toEqual([snapshot, delta]);
  });
});
