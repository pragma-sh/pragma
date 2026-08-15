import { describe, expect, it } from "vitest";

import { agentSessionTitle } from "./tab-title";

describe("agentSessionTitle", () => {
  it("uses the shared fallback until a session has a name", () => {
    expect(agentSessionTitle(null)).toBe("Shell");
    expect(agentSessionTitle("  ")).toBe("Shell");
  });

  it("prefers the tab title the desktop shows", () => {
    expect(agentSessionTitle("Fix flaky tests", "stale name")).toBe("Fix flaky tests");
  });

  it("falls back to the agent-reported session name for an unnamed tab", () => {
    expect(agentSessionTitle(null, "Fix flaky tests")).toBe("Fix flaky tests");
    expect(agentSessionTitle("Shell", "Fix flaky tests")).toBe("Fix flaky tests");
  });
});
