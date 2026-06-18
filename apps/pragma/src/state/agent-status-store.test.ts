import type { AgentReportPayload, AgentStatus } from "@pragma/constants";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyAgentReport,
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

describe("removeAgentStatusForTab", () => {
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
});
