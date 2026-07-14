import { expect, it, vi } from "vitest";

import { cursorAgentPlugin, loadCursorUsageLimits, parseCursorUsageSummary } from "./pragma-plugin";

it("links to Cursor's usage dashboard", () => {
  expect(cursorAgentPlugin.usageLimits?.[0]?.dashboardUrl).toBe(
    "https://cursor.com/dashboard/spending",
  );
});

it("submits interjections in a separate PTY write", async () => {
  const watcher = cursorAgentPlugin.watchers?.[0];
  expect(watcher).toBeDefined();

  const controller = new AbortController();
  const sendKeys = vi.fn(async () => {});
  const context = {
    sdk: {
      agents: {
        connect: async () => ({
          async *[Symbol.asyncIterator]() {
            try {
              yield {
                type: "agentInput",
                input: {
                  agent: "cursor",
                  worktreeId: "worktree-1",
                  tabId: "tab-1",
                  text: "continue",
                },
              };
            } finally {
              controller.abort();
            }
          },
        }),
      },
    },
    agentId: "cursor",
    config: undefined,
    session: { id: "session-1", tabId: "tab-1", worktreeId: "worktree-1" },
    output: (async function* () {})(),
    sendKeys,
    reportMessage: async () => {},
    signal: controller.signal,
  };

  await watcher?.watch(context as never);

  expect(sendKeys).toHaveBeenNthCalledWith(1, "continue");
  expect(sendKeys).toHaveBeenNthCalledWith(2, "\r");
});

it("reports API and first-party usage with an averaged summary", () => {
  const observedAt = Date.parse("2026-07-01T00:00:00Z");
  const result = parseCursorUsageSummary(
    {
      billingCycleEnd: "2026-08-01T00:00:00Z",
      individualUsage: {
        plan: { enabled: true, apiPercentUsed: 60, autoPercentUsed: 20 },
      },
    },
    observedAt,
  );

  expect(result).toEqual({
    status: "ready",
    observedAt,
    summary: {
      id: "average",
      title: "Average usage",
      used: 40,
      limit: 100,
      resetsInMs: 31 * 24 * 60 * 60 * 1000,
    },
    limits: [
      {
        id: "api",
        title: "API usage",
        used: 60,
        limit: 100,
        resetsInMs: 31 * 24 * 60 * 60 * 1000,
      },
      {
        id: "first-party",
        title: "First-party usage",
        used: 20,
        limit: 100,
        resetsInMs: 31 * 24 * 60 * 60 * 1000,
      },
    ],
  });
});

it("clamps Cursor percentage fields", () => {
  const result = parseCursorUsageSummary(
    {
      individualUsage: {
        plan: { apiPercentUsed: 120, autoPercentUsed: -5 },
      },
    },
    1,
  );

  expect(result).toMatchObject({
    status: "ready",
    summary: { used: 50 },
    limits: [
      { id: "api", used: 100, limit: 100 },
      { id: "first-party", used: 0, limit: 100 },
    ],
  });
});

it("requires both Cursor usage percentages", () => {
  const result = parseCursorUsageSummary({ individualUsage: { plan: { apiPercentUsed: 25 } } }, 1);

  expect(result).toMatchObject({ status: "unavailable", reason: "unsupported" });
});

it("runs the bundled helper without passing credentials through the command", async () => {
  let capturedRequest: { cwd: string; commands: string[] } | undefined;
  const run = vi.fn(async (request: { cwd: string; commands: string[] }) => {
    capturedRequest = request;
    return [
      {
        command: "usage helper",
        stdout: JSON.stringify({
          individualUsage: { plan: { apiPercentUsed: 10, autoPercentUsed: 20 } },
        }),
        stderr: "",
        status: 0,
        durationMs: 1,
      },
    ];
  });

  const result = await loadCursorUsageLimits({
    pluginId: "pragma.cursor",
    pluginDir: "/Applications/Pragma App/plugins/cursor",
    config: undefined,
    project: { id: "p", name: "Project", path: "/project" },
    sdk: { exec: { run } } as never,
    notify: () => {},
  });

  expect(result).toMatchObject({ status: "ready", summary: { used: 15 } });
  expect(capturedRequest).toEqual({
    cwd: "/project",
    commands: [
      expect.stringContaining("/Applications/Pragma App/plugins/cursor/assets/usage-limits.py"),
    ],
  });
  expect(capturedRequest?.commands[0]).not.toContain("WorkosCursorSessionToken");
});
