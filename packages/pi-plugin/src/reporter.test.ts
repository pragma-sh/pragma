import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiLifecycleReporter, sessionNameFromPrompt, type PiReporter } from "./reporter";

function harness() {
  const events: string[] = [];
  const reporter: PiReporter = {
    started: vi.fn(async () => void events.push("started")),
    stopped: vi.fn(async () => void events.push("stopped")),
    cleared: vi.fn(async () => void events.push("cleared")),
    message: vi.fn(async () => {}),
    sessionName: vi.fn(async (name: string) => void events.push(`sessionName:${name}`)),
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

describe("sessionNameFromPrompt", () => {
  it("uses the prompt's first line and caps long ones", () => {
    expect(sessionNameFromPrompt("Fix flaky tests\nplease")).toBe("Fix flaky tests");
    const long = "a".repeat(60);
    expect(sessionNameFromPrompt(long)).toBe(`${"a".repeat(47)}…`);
    expect(sessionNameFromPrompt("   ")).toBe("");
  });
});

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

  it("names the session once per session from the first prompt", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.nameSessionFromPrompt("Fix flaky tests\nmore detail");
    await lifecycle.nameSessionFromPrompt("Second prompt");
    expect(events).toEqual(["sessionName:Fix flaky tests"]);
  });
  it("renames on the first prompt after a clear (new session)", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.nameSessionFromPrompt("First session");
    await lifecycle.clear();
    await lifecycle.nameSessionFromPrompt("Second session");
    expect(events).toEqual(["sessionName:First session", "cleared", "sessionName:Second session"]);
  });
});
