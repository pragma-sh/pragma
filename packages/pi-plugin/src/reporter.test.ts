import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiLifecycleReporter, type PiReporter } from "./reporter";

function harness() {
  const events: string[] = [];
  const reporter: PiReporter = {
    started: vi.fn(async () => void events.push("started")),
    stopped: vi.fn(async () => void events.push("stopped")),
    cleared: vi.fn(async () => void events.push("cleared")),
    message: vi.fn(async () => {}),
  };
  return { events, lifecycle: new PiLifecycleReporter(reporter) };
}

function end(stopReason: "stop" | "aborted" = "stop"): AgentEndEvent {
  return {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: 1,
      },
    ],
  };
}

describe("PiLifecycleReporter", () => {
  it("reports stopped only after a started turn", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.end(end());
    await lifecycle.start();
    await lifecycle.end(end());
    expect(events).toEqual(["started", "stopped"]);
  });
  it("clears an aborted turn", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.start();
    await lifecycle.end(end("aborted"));
    expect(events).toEqual(["started", "cleared"]);
  });
  it("deduplicates repeated start and end events", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.start();
    await lifecycle.start();
    await lifecycle.end(end());
    await lifecycle.end(end());
    expect(events).toEqual(["started", "stopped"]);
  });
});
