import type { PluginContext } from "@pragma/plugin/catalog";
import { describe, expect, it, vi } from "vitest";

import opencodeAgentPlugin from "./pragma-plugin";
import { loadOpenCodeGoUsageLimits, parseOpenCodeGoUsage } from "./usage-limits";

const aggregate = {
  observedAt: 1_800_000_000_000,
  rollingUsed: 3,
  rollingResetsAt: 1_800_003_600_000,
  weeklyUsed: 12,
  weeklyResetsAt: 1_800_086_400_000,
  monthlyUsed: 24,
  monthlyResetsAt: 1_801_000_000_000,
  messageCount: 10,
};

describe("OpenCode Go usage limits", () => {
  it("registers the provider as an agent capability", () => {
    expect(opencodeAgentPlugin.usageLimits?.[0]).toMatchObject({
      id: "opencode-go",
      primaryLimitId: "rolling",
    });
    expect(opencodeAgentPlugin.agents?.[0]?.excludeFeatures ?? []).not.toContain("usageLimits");
  });

  it("normalizes local cost windows and reset times", () => {
    expect(parseOpenCodeGoUsage(JSON.stringify([aggregate]))).toEqual({
      status: "ready",
      observedAt: aggregate.observedAt,
      limits: [
        { id: "rolling", title: "5-hour limit", used: 3, limit: 12, resetsInMs: 3_600_000 },
        { id: "weekly", title: "Weekly limit", used: 12, limit: 30, resetsInMs: 86_400_000 },
        {
          id: "monthly",
          title: "Monthly limit",
          used: 24,
          limit: 60,
          resetsInMs: 1_000_000_000,
        },
      ],
    });
  });

  it("reports unsupported before device-local Go usage exists", () => {
    expect(parseOpenCodeGoUsage(JSON.stringify([{ ...aggregate, messageCount: 0 }]))).toEqual({
      status: "unavailable",
      reason: "unsupported",
      message: "No device-local OpenCode Go usage was found.",
    });
  });

  it("throws for malformed query output", () => {
    expect(() => parseOpenCodeGoUsage("not json")).toThrow("invalid JSON");
    expect(() =>
      parseOpenCodeGoUsage(JSON.stringify([{ ...aggregate, rollingUsed: null }])),
    ).toThrow("malformed 5-hour limit usage");
  });

  it("reports a missing OpenCode installation as not configured", async () => {
    const run = vi.fn().mockResolvedValue([{ status: 20, stdout: "", stderr: "" }]);
    const ctx = { sdk: { exec: { run } }, project: null } as unknown as PluginContext;

    await expect(loadOpenCodeGoUsageLimits(ctx)).resolves.toEqual({
      status: "unavailable",
      reason: "not-configured",
      message: "Install OpenCode to load OpenCode Go usage limits.",
    });
  });
});
