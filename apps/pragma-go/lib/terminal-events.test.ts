import { bytesToBase64 } from "@pragma-sh/sdk";
import { describe, expect, it } from "vitest";

import { applyTerminalEvent, type StreamTarget, type TerminalStatus } from "./terminal-events";

/** A recording target: the renderer writes, the cursor, and the status trail. */
function recorder() {
  const writes: Array<{ dataBase64: string; cursor: number }> = [];
  const statuses: TerminalStatus[] = [];
  const target: StreamTarget = {
    cursor: { current: null },
    sink: {
      onOutput: (dataBase64, cursor) => writes.push({ dataBase64, cursor }),
      onReset: () => undefined,
    },
    setStatus: (status) => statuses.push(status),
    setExitCode: () => undefined,
  };
  return { target, writes, statuses };
}

const output = (text: string) => ({
  type: "output",
  sessionId: "s1",
  dataBase64: bytesToBase64(new TextEncoder().encode(text)),
});
const replay = { type: "replay", sessionId: "s1", cursor: 100, reset: false };
const heartbeat = { type: "ready" };

function feed(events: Array<{ type: string }>) {
  const recorded = recorder();
  for (const event of events) applyTerminalEvent(event, recorded.target);
  return recorded;
}

describe("applyTerminalEvent", () => {
  it("ignores the gateway's initial heartbeat and goes live on replay/output", () => {
    const { target, writes, statuses } = feed([heartbeat, replay, output("hello")]);

    expect(statuses.at(-1)).toBe("live");
    expect(writes).toEqual([{ dataBase64: output("hello").dataBase64, cursor: 100 }]);
    expect(target.cursor.current).toBe(105);
  });

  it("ignores a periodic heartbeat between output events", () => {
    const { target, writes } = feed([heartbeat, replay, output("ab"), heartbeat, output("cde")]);

    expect(writes.map((write) => write.cursor)).toEqual([100, 102]);
    expect(target.cursor.current).toBe(105);
  });

  it("ignores an event type a newer host might add", () => {
    const { target, writes, statuses } = feed([
      { type: "somethingNew" },
      replay,
      { type: "toString" },
      output("x"),
    ]);

    expect(statuses.at(-1)).toBe("live");
    expect(writes).toHaveLength(1);
    expect(target.cursor.current).toBe(101);
  });
});
