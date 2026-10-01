import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMessage, AgentProgressEstimate, AgentStatus } from "@pragma-sh/constants";

import type { AgentProgressInput } from "@/lib/tauri";
import {
  agentActivityLabel,
  AgentProgressTracker,
  useAgentProgress,
} from "@/state/agent-progress-store";
import { deferred } from "@/test/deferred";

vi.mock("@/lib/tauri", () => ({
  system1AgentProgress: vi.fn(),
  system1Status: vi.fn(async () => ({ configured: false, baseUrl: "", model: "" })),
}));

let seq = 0;
function message(role: AgentMessage["role"], text: string, extra: Partial<AgentMessage> = {}) {
  seq += 1;
  return {
    agent: "claude",
    worktreeId: "wt-1",
    tabId: "tab-1",
    id: `m${seq}`,
    role,
    text,
    subAgentsActive: 0,
    ts: seq,
    ...extra,
  } satisfies AgentMessage;
}

interface Harness {
  tracker: AgentProgressTracker;
  estimate: ReturnType<typeof vi.fn<(input: AgentProgressInput) => Promise<AgentProgressEstimate>>>;
  status: { value: AgentStatus | null };
}

function harness(): Harness {
  const status = { value: "running" as AgentStatus | null };
  const estimate = vi.fn(
    async (_input: AgentProgressInput): Promise<AgentProgressEstimate> => ({
      progress: 0.4,
      activity: "coding",
      confidence: 0.8,
    }),
  );
  const tracker = new AgentProgressTracker({
    estimate,
    statusOf: () => status.value,
    agentName: () => "Claude Code",
    debounceMs: 100,
    errorBackoffMs: 1000,
  });
  return { tracker, estimate, status };
}

function progress() {
  return renderHook(() => useAgentProgress("wt-1", "tab-1", "claude")).result.current;
}

describe("AgentProgressTracker", () => {
  let current: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    current = harness();
    current.tracker.handleStatuses([
      { worktreeId: "wt-1", tabId: "tab-1", agent: "claude", status: "running" },
    ]);
  });

  afterEach(() => {
    current.tracker.handleStatuses([]);
    current.tracker.dispose();
    vi.useRealTimers();
  });

  it("estimates once per burst, from the first prompt and the latest reply", async () => {
    current.tracker.setEnabled(true);
    current.tracker.handleMessage(message("user", "Add a progress bar"));
    current.tracker.handleMessage(message("assistant", "Reading the sidebar"));
    current.tracker.handleMessage(message("assistant", "Editing WorktreeTree.tsx"));
    await vi.advanceTimersByTimeAsync(100);
    expect(current.estimate).toHaveBeenCalledTimes(1);
    expect(current.estimate).toHaveBeenCalledWith({
      agent: "Claude Code",
      status: "running",
      prompt: "Add a progress bar",
      followUp: null,
      lastMessage: "Editing WorktreeTree.tsx",
      recentTools: [],
    });
    expect(progress()).toMatchObject({ progress: 0.4, activity: "coding" });
  });

  it("does nothing while disabled, then catches up when enabled", async () => {
    current.tracker.handleMessage(message("user", "Fix it"));
    current.tracker.handleMessage(message("assistant", "Looking"));
    await vi.advanceTimersByTimeAsync(500);
    expect(current.estimate).not.toHaveBeenCalled();
    current.tracker.setEnabled(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(current.estimate).toHaveBeenCalledTimes(1);
  });

  it("re-runs once after a message lands mid-request", async () => {
    const pending = deferred<AgentProgressEstimate>();
    current.estimate.mockImplementationOnce(() => pending.promise);
    current.tracker.setEnabled(true);
    current.tracker.handleMessage(message("assistant", "First"));
    await vi.advanceTimersByTimeAsync(100);
    current.tracker.handleMessage(message("assistant", "Second"));
    current.tracker.handleMessage(message("assistant", "Third"));
    await vi.advanceTimersByTimeAsync(100);
    expect(current.estimate).toHaveBeenCalledTimes(1);
    pending.resolve({ progress: 0.1, activity: "exploring", confidence: 0.5 });
    await vi.advanceTimersByTimeAsync(100);
    expect(current.estimate).toHaveBeenCalledTimes(2);
    expect(current.estimate.mock.calls[1]?.[0].lastMessage).toBe("Third");
  });

  it("passes a differing follow-up and recent tool names", async () => {
    current.tracker.setEnabled(true);
    current.tracker.handleMessage(message("user", "Build the feature"));
    current.tracker.handleMessage(message("user", "Also add tests"));
    current.tracker.handleMessage(
      message("tool", "", { toolCalls: [{ id: "t1", name: "Bash", status: "running" }] }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(current.estimate.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Build the feature",
      followUp: "Also add tests",
      recentTools: ["Bash"],
    });
  });

  it("skips finished agents and pauses after a failure", async () => {
    current.tracker.setEnabled(true);
    current.status.value = "done";
    current.tracker.handleMessage(message("assistant", "All done"));
    await vi.advanceTimersByTimeAsync(100);
    expect(current.estimate).not.toHaveBeenCalled();

    current.status.value = "running";
    current.estimate.mockRejectedValueOnce(new Error("401"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    current.tracker.handleMessage(message("assistant", "Working"));
    await vi.advanceTimersByTimeAsync(100);
    current.tracker.handleMessage(message("assistant", "Still working"));
    await vi.advanceTimersByTimeAsync(100);
    expect(current.estimate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("forgets an agent whose status disappears, so its next prompt is a new task", async () => {
    current.tracker.setEnabled(true);
    current.tracker.handleMessage(message("user", "Old task"));
    current.tracker.handleMessage(message("assistant", "Done with old task"));
    await vi.advanceTimersByTimeAsync(100);
    expect(progress()).not.toBeNull();

    current.tracker.handleStatuses([]);
    expect(progress()).toBeNull();

    current.tracker.handleStatuses([
      { worktreeId: "wt-1", tabId: "tab-1", agent: "claude", status: "running" },
    ]);
    current.tracker.handleMessage(message("user", "New task"));
    current.tracker.handleMessage(message("assistant", "Starting"));
    await vi.advanceTimersByTimeAsync(100);
    expect(current.estimate.mock.calls.at(-1)?.[0]).toMatchObject({
      prompt: "New task",
      followUp: null,
    });
  });
});

describe("agentActivityLabel", () => {
  it("maps a shared activity id to its label and passes unknown ids through", () => {
    expect(agentActivityLabel("coding")).toBe("Coding");
    expect(agentActivityLabel("mystery")).toBe("mystery");
  });
});
