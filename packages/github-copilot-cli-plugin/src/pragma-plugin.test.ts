import { expect, it, vi } from "vitest";

import { githubCopilotCliPlugin } from "./pragma-plugin";
import {
  extractGitHubCopilotUsageLimits,
  loadGitHubCopilotUsageLimits,
  parseGitHubCopilotUsageLimits,
} from "./usage-limits";

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

it("defines GitHub Copilot launcher and usage UI", () => {
  const agent = githubCopilotCliPlugin.agents?.[0];
  const usage = githubCopilotCliPlugin.usageLimits?.[0];
  expect(agent?.id).toBe("github-copilot");
  expect(agent?.launch.command).toEqual(["copilot", "--no-auto-update"]);
  expect(agent?.excludeFeatures).toEqual(["abort", "interrupt"]);
  expect(agent?.prefillDelayMs).toBe(25000);
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
        quotaSnapshots: {
          chat: {
            isUnlimitedEntitlement: false,
            usedRequests: 120,
            entitlementRequests: 1500,
            resetDate: "2026-08-01T00:00:00Z",
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
      limit: 1500,
      resetsInMs: 518_400_000,
    },
    limits: [
      {
        id: "ai-credits",
        title: "AI credits",
        used: 120,
        limit: 1500,
        resetsInMs: 518_400_000,
      },
    ],
  });
});

it("returns unsupported when Copilot omits quota", () => {
  expect(parseGitHubCopilotUsageLimits({ quotaSnapshots: {} }, 1)).toMatchObject({
    status: "unavailable",
    reason: "unsupported",
  });
});

it("advances Copilot's cycle-start reset date by its 30-day billing cycle", () => {
  const observedAt = Date.parse("2026-07-26T12:00:00Z");
  const result = parseGitHubCopilotUsageLimits(
    {
      quotaSnapshots: {
        chat: {
          isUnlimitedEntitlement: false,
          usedRequests: 10,
          entitlementRequests: 100,
          resetDate: "2026-07-26T12:00:00Z",
        },
      },
    },
    observedAt,
  );

  expect(result).toMatchObject({
    status: "ready",
    limits: [{ resetsInMs: 30 * 24 * 60 * 60 * 1000 }],
  });
});

it("loads usage through authenticated Copilot CLI", async () => {
  const quotaResponse = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: {
      quotaSnapshots: {
        chat: {
          isUnlimitedEntitlement: false,
          usedRequests: 10,
          entitlementRequests: 100,
        },
      },
    },
  });
  const run = vi.fn(async (_request: { cwd: string; commands: string[] }) => [
    {
      command: "copilot --stdio",
      stdout: `Content-Length: ${byteLength(quotaResponse)}\r\n\r\n${quotaResponse}`,
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
  expect(run).toHaveBeenCalledWith({ cwd: "/project", commands: [expect.any(String)] });
  const command = run.mock.calls[0]?.[0].commands[0];
  expect(command).toContain('exec "${SHELL:-/bin/sh}" -lic ');
  expect(command).toContain("copilot --headless");
});

it("maps Copilot runtime authentication errors", () => {
  const response = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32_000, message: "Not logged in - café" },
  });
  expect(
    extractGitHubCopilotUsageLimits(
      `Content-Length: ${byteLength(response)}\r\n\r\n${response}`,
      1,
    ),
  ).toMatchObject({ status: "unavailable", reason: "authentication-required" });
});
