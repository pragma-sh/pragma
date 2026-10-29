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
    sessionId: vi.fn(async (id: string | null) => void events.push(`sessionId:${id ?? "null"}`)),
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

/** A session whose file Pi has written: its id is a resumable locator. */
const materialized = (id: string) => ({ id, locator: id });
/** A session Pi has not written yet: it has no resumable locator. */
const pending = (id: string) => ({ id, locator: null });

describe("PiLifecycleReporter session identity", () => {
  it("reports each identity transition, including a return to a previous session", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.identifySession(materialized("a"));
    await lifecycle.identifySession(materialized("a"));
    await lifecycle.identifySession(materialized("b"));
    await lifecycle.identifySession(materialized("a"));
    expect(events).toEqual(["sessionId:a", "sessionId:b", "sessionId:a"]);
  });

  it("keeps same-title sessions distinct by identity", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.identifySession(materialized("a"));
    await lifecycle.nameSessionFromPrompt("Deploy the release");
    await lifecycle.clear();
    await lifecycle.identifySession(materialized("b"));
    await lifecycle.nameSessionFromPrompt("Deploy the release");
    expect(events).toEqual([
      "sessionId:a",
      "sessionName:Deploy the release",
      "cleared",
      "sessionId:b",
      "sessionName:Deploy the release",
    ]);
  });

  it("clears the stored conversation when the session changes to one with no file yet", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.identifySession(materialized("a"));
    await lifecycle.identifySession(pending("b"));
    expect(events).toEqual(["sessionId:a", "sessionId:null"]);
  });

  it("does not clear again while the same pending session is observed", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.identifySession(materialized("a"));
    await lifecycle.identifySession(pending("b"));
    await lifecycle.identifySession(pending("b"));
    await lifecycle.identifySession(pending("b"));
    expect(events).toEqual(["sessionId:a", "sessionId:null"]);
  });

  it("reports the id once the pending session's file materializes", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.identifySession(materialized("a"));
    await lifecycle.identifySession(pending("b"));
    await lifecycle.identifySession(materialized("b"));
    expect(events).toEqual(["sessionId:a", "sessionId:null", "sessionId:b"]);
  });

  it("never clears a known id when the same session's file is not found", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.identifySession(materialized("a"));
    await lifecycle.identifySession(pending("a"));
    await lifecycle.identifySession(pending("a"));
    expect(events).toEqual(["sessionId:a"]);
  });

  it("keeps the known id across a generic clear or shutdown", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.identifySession(materialized("a"));
    await lifecycle.clear();
    await lifecycle.identifySession(pending("a"));
    await lifecycle.identifySession(materialized("a"));
    expect(events).toEqual(["sessionId:a", "cleared"]);
  });

  it("reports a switch back to a previously seen session once it materializes", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.identifySession(materialized("a"));
    await lifecycle.identifySession(pending("b"));
    await lifecycle.identifySession(materialized("a"));
    expect(events).toEqual(["sessionId:a", "sessionId:null", "sessionId:a"]);
  });

  it("reports Pi's own session name and lets it win over the prompt fallback", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.nameSession("Native name");
    await lifecycle.nameSessionFromPrompt("Prompt line");
    expect(events).toEqual(["sessionName:Native name"]);
  });

  it("lets the prompt name the session again once Pi clears its own name", async () => {
    const { events, lifecycle } = harness();
    await lifecycle.nameSession("Native name");
    await lifecycle.nameSession(undefined);
    await lifecycle.nameSessionFromPrompt("Prompt line");
    expect(events).toEqual(["sessionName:Native name", "sessionName:Prompt line"]);
  });
});
