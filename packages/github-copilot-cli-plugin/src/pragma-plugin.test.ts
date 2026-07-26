import { expect, it, vi } from "vitest";

import { githubCopilotCliPlugin } from "./pragma-plugin";
import { loadGitHubCopilotUsageLimits, parseGitHubCopilotUsageLimits } from "./usage-limits";

it("defines GitHub Copilot launcher and usage UI", () => {
  const agent = githubCopilotCliPlugin.agents?.[0];
  const usage = githubCopilotCliPlugin.usageLimits?.[0];
  expect(agent?.id).toBe("github-copilot");
  expect(agent?.launch.command).toEqual(["copilot", "--no-auto-update"]);
  expect(agent?.excludeFeatures).toEqual(["questions", "abort", "interrupt"]);
  expect(agent?.args.modelReasoning?.("gpt-5.6-sol", "high")).toEqual([
    "--model",
    "gpt-5.6-sol",
    "--effort",
    "high",
  ]);
  expect(agent?.args.permissionMode("allow-all")).toEqual(["--allow-all"]);
  expect(usage).toMatchObject({
    id: "github-copilot",
    primaryLimitId: "ai-credits",
    iconPath: "assets/copilot.png",
  });
});

it("normalizes GitHub Copilot AI-credit usage", () => {
  const observedAt = Date.parse("2026-07-26T00:00:00Z");
  expect(
    parseGitHubCopilotUsageLimits(
      {
        quota_reset_date_utc: "2026-08-01T00:00:00Z",
        quota_snapshots: {
          premium_interactions: {
            credits_used: 120,
            entitlement: 1500,
            overage_entitlement: 100,
          },
        },
      },
      observedAt,
    ),
  ).toEqual({
    status: "ready",
    observedAt,
    summary: {
      id: "ai-credits",
      title: "AI credits",
      used: 120,
      limit: 1600,
      resetsInMs: 518_400_000,
    },
    limits: [
      {
        id: "ai-credits",
        title: "AI credits",
        used: 120,
        limit: 1600,
        resetsInMs: 518_400_000,
      },
    ],
  });
});

it("returns unsupported when GitHub omits Copilot quota", () => {
  expect(parseGitHubCopilotUsageLimits({ quota_snapshots: {} }, 1)).toMatchObject({
    status: "unavailable",
    reason: "unsupported",
  });
});

it("loads usage through authenticated GitHub CLI", async () => {
  const run = vi.fn(async () => [
    {
      command: "gh api",
      stdout: JSON.stringify({
        quota_snapshots: {
          premium_interactions: { credits_used: 10, entitlement: 100 },
        },
      }),
      stderr: "",
      status: 0,
      durationMs: 1,
    },
  ]);
  const result = await loadGitHubCopilotUsageLimits({
    pluginId: "pragma.github-copilot",
    config: undefined,
    project: { id: "p", name: "Project", path: "/project" },
    sdk: { exec: { run } } as never,
    notify: () => {},
  });
  expect(result).toMatchObject({ status: "ready", limits: [{ used: 10, limit: 100 }] });
  expect(run).toHaveBeenCalledWith({
    cwd: "/project",
    commands: [expect.stringContaining("gh api copilot_internal/user")],
  });
});
