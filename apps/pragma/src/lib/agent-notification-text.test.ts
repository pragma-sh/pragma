import type { AgentReportPayload } from "@pragma/constants";
import { describe, expect, it } from "vitest";

import { agentAlertBody, agentAlertTitle } from "./agent-notification-text";

function report(overrides: Partial<AgentReportPayload> = {}): AgentReportPayload {
  return {
    agent: "opencode",
    status: "attention",
    tabId: "tab-1",
    worktreeId: "worktree-1",
    ...overrides,
  };
}

describe("agentAlertTitle", () => {
  it("names the agent and what it wants", () => {
    expect(agentAlertTitle(report({ status: "done" }), "OpenCode")).toBe("OpenCode finished");
    expect(agentAlertTitle(report({ attentionKind: "question" }), "Claude Code")).toBe(
      "Claude Code is waiting for an answer",
    );
    expect(agentAlertTitle(report({ attentionKind: "command" }), "Codex")).toBe(
      "Codex wants to run a command",
    );
    expect(agentAlertTitle(report(), "Cursor")).toBe("Cursor needs attention");
  });
});

describe("agentAlertBody", () => {
  it("reads project, worktree, then tab", () => {
    expect(
      agentAlertBody({ projectName: "pragma", worktreeName: "bugfix-auth", tabName: "dev" }),
    ).toBe('pragma / bugfix-auth · tab "dev"');
  });

  it("drops parts that are missing or blank", () => {
    expect(agentAlertBody({ projectName: "pragma", worktreeName: "  " })).toBe("pragma");
    expect(agentAlertBody({ worktreeName: "bugfix-auth" })).toBe("bugfix-auth");
  });

  it("drops the separator when only the tab is known", () => {
    expect(agentAlertBody({ tabName: "dev" })).toBe('tab "dev"');
  });

  it("falls back when the report's location is unknown", () => {
    expect(agentAlertBody()).toBe("Open Pragma to continue.");
    expect(agentAlertBody({ projectName: null, worktreeName: null, tabName: null })).toBe(
      "Open Pragma to continue.",
    );
  });
});
