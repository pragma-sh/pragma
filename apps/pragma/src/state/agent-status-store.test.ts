import type { AgentReportPayload, AgentStatus } from "@pragma/constants";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentStatusesForTab,
  applyAgentReport,
  clearAllAgentStatuses,
  clearDoneStatusForTab,
  removeAgentStatusForTab,
  tabStatus,
  worktreeStatus,
} from "@/state/agent-status-store";

function report(
  worktreeId: string,
  tabId: string,
  agent: string,
  status: AgentStatus,
): AgentReportPayload {
  return { worktreeId, tabId, agent, status };
}

// Clear the module-level store between tests by removing every tab we touch.
afterEach(() => {
  removeAgentStatusForTab("tab-a");
  removeAgentStatusForTab("tab-b");
});

describe("agent status store", () => {
  it("updates a tab status when a new report arrives for the same agent", () => {
    applyAgentReport(report("wt-1", "tab-a", "claude", "running"));
    expect(tabStatus("tab-a")).toBe("running");

    applyAgentReport(report("wt-1", "tab-a", "claude", "done"));

    expect(tabStatus("tab-a")).toBe("done");
    expect(worktreeStatus("wt-1")).toBe("done");
  });

  it("clears the worktree indicator when the closed tab held the only agent", () => {
    applyAgentReport(report("wt-1", "tab-a", "claude", "running"));
    expect(worktreeStatus("wt-1")).toBe("running");

    removeAgentStatusForTab("tab-a");

    expect(tabStatus("tab-a")).toBeNull();
    expect(worktreeStatus("wt-1")).toBeNull();
  });

  it("keeps the worktree indicator when another tab still has a running agent", () => {
    applyAgentReport(report("wt-1", "tab-a", "claude", "running"));
    applyAgentReport(report("wt-1", "tab-b", "codex", "running"));

    removeAgentStatusForTab("tab-a");

    expect(tabStatus("tab-a")).toBeNull();
    expect(worktreeStatus("wt-1")).toBe("running");
  });

  it("removes even a running status, unlike the view-clear path", () => {
    applyAgentReport(report("wt-1", "tab-a", "claude", "running"));

    removeAgentStatusForTab("tab-a");

    expect(tabStatus("tab-a")).toBeNull();
  });

  it("clears a done indicator when the tab is viewed", () => {
    applyAgentReport(report("wt-1", "tab-a", "claude", "done"));
    expect(worktreeStatus("wt-1")).toBe("done");

    clearDoneStatusForTab("tab-a");

    expect(tabStatus("tab-a")).toBeNull();
    expect(worktreeStatus("wt-1")).toBeNull();
  });

  it("keeps running and attention indicators through a view-clear", () => {
    applyAgentReport(report("wt-1", "tab-a", "claude", "running"));
    applyAgentReport(report("wt-1", "tab-b", "codex", "attention"));

    clearDoneStatusForTab("tab-a");
    clearDoneStatusForTab("tab-b");

    expect(tabStatus("tab-a")).toBe("running");
    expect(tabStatus("tab-b")).toBe("attention");
  });

  it("drops worktree green only once every finished tab is viewed", () => {
    applyAgentReport(report("wt-1", "tab-a", "claude", "done"));
    applyAgentReport(report("wt-1", "tab-b", "codex", "done"));
    expect(worktreeStatus("wt-1")).toBe("done");

    clearDoneStatusForTab("tab-a");
    expect(worktreeStatus("wt-1")).toBe("done");

    clearDoneStatusForTab("tab-b");
    expect(worktreeStatus("wt-1")).toBeNull();
  });

  it("removes an agent entirely on a cleared report, unlike done", () => {
    applyAgentReport(report("wt-1", "tab-a", "claude", "running"));
    expect(tabStatus("tab-a")).toBe("running");

    const previous = applyAgentReport(report("wt-1", "tab-a", "claude", "cleared"));

    expect(previous).toBe("running");
    expect(tabStatus("tab-a")).toBeNull();
    expect(worktreeStatus("wt-1")).toBeNull();
  });

  it("clears only the reporting agent, leaving other agents on the tab", () => {
    applyAgentReport(report("wt-1", "tab-a", "claude", "running"));
    applyAgentReport(report("wt-1", "tab-a", "codex", "attention"));

    applyAgentReport(report("wt-1", "tab-a", "claude", "cleared"));

    expect(tabStatus("tab-a")).toBe("attention");
  });

  it("lists every stored agent entry for a tab so views can latch them", () => {
    applyAgentReport(report("wt-1", "tab-a", "claude", "attention"));
    applyAgentReport(report("wt-1", "tab-a", "codex", "done"));

    expect(agentStatusesForTab("tab-a")).toEqual(
      expect.arrayContaining([
        { worktreeId: "wt-1", agent: "claude", status: "attention" },
        { worktreeId: "wt-1", agent: "codex", status: "done" },
      ]),
    );
    expect(agentStatusesForTab("tab-b")).toEqual([]);
  });

  it("clears all cached statuses for a fresh daemon snapshot", () => {
    applyAgentReport(report("wt-1", "tab-a", "claude", "done"));
    applyAgentReport(report("wt-1", "tab-b", "codex", "attention"));

    clearAllAgentStatuses();

    expect(tabStatus("tab-a")).toBeNull();
    expect(tabStatus("tab-b")).toBeNull();
    expect(worktreeStatus("wt-1")).toBeNull();
  });
});
