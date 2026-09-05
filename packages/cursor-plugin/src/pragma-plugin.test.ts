import { expect, it, vi } from "vitest";

import {
  cursorAgentPlugin,
  loadCursorUsageLimits,
  parseCursorModels,
  parseCursorUsageSummary,
} from "./pragma-plugin";

it("launches Cursor's unambiguous binary", () => {
  expect(cursorAgentPlugin.agents?.[0]?.launch.command).toEqual([
    "cursor-agent",
    "--force",
    "--approve-mcps",
  ]);
  expect(cursorAgentPlugin.agents?.[0]?.excludeFeatures).toEqual([
    "commandApproval",
    "subagents",
    "abort",
    "interrupt",
  ]);
  expect(cursorAgentPlugin.agents?.[0]?.startupInput).toBeUndefined();
});

it("approves workspace trust only after Cursor renders the complete prompt", async () => {
  const watcher = cursorAgentPlugin.watchers?.[0];
  const controller = new AbortController();
  const sendKeys = vi.fn(async () => {});
  const context = {
    sdk: {
      agents: {
        connect: async () => ({
          async *[Symbol.asyncIterator]() {
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.abort();
            yield* [];
          },
        }),
        report: async () => {},
      },
    },
    agentId: "cursor",
    config: undefined,
    session: { id: "session-1", tabId: "tab-1", worktreeId: "worktree-1" },
    output: (async function* () {
      yield "\x1b[1mWorkspace Trust";
      yield " Required\x1b[0m\n";
      expect(sendKeys).not.toHaveBeenCalled();
      yield "[a] Trust this workspace";
      yield "\r\x1b[1AWorkspace Trust Required\n[a] Trust this workspace";
    })(),
    sendKeys,
    reportMessage: async () => {},
    signal: controller.signal,
  };

  await watcher?.watch(context as never);

  expect(sendKeys).toHaveBeenCalledOnce();
  expect(sendKeys).toHaveBeenCalledWith("a");
});

it("reports question attention from Cursor's OSC titles", async () => {
  const watcher = cursorAgentPlugin.watchers?.[0];
  const controller = new AbortController();
  const report = vi.fn(async () => {});
  const context = {
    sdk: {
      agents: {
        connect: async () => ({
          async *[Symbol.asyncIterator]() {
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.abort();
            yield* [];
          },
        }),
        report,
      },
    },
    agentId: "cursor",
    config: undefined,
    session: { id: "session-1", tabId: "tab-1", worktreeId: "worktree-1" },
    output: (async function* () {
      yield "\x1b]0;Choice";
      yield " Asker\x07";
      yield "\x1b]2;Cursor Agent\x1b\\";
    })(),
    sendKeys: async () => {},
    reportMessage: async () => {},
    signal: controller.signal,
  };

  await watcher?.watch(context as never);

  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({ status: "attention", attentionKind: "question" }),
  );
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({ status: "running", attentionKind: null }),
  );
});

it("includes Cursor's auto model", () => {
  expect(parseCursorModels("Available models\n\nauto - Auto (current, default)\n")).toEqual([
    { id: "auto", name: "Auto (current, default)" },
  ]);
});

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
  const report = vi.fn(async () => {});
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
        report,
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

  expect(sendKeys).toHaveBeenNthCalledWith(1, "\x1b[200~continue\x1b[201~");
  expect(sendKeys).toHaveBeenNthCalledWith(2, "\r");
  expect(report).toHaveBeenCalledWith({
    agent: "cursor",
    tabId: "tab-1",
    worktreeId: "worktree-1",
    status: "cleared",
    attentionKind: null,
  });
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
    commands: [expect.stringContaining("$HOME/.pragma/plugins/cursor/scripts/usage-limits")],
  });
  expect(capturedRequest?.commands[0]).not.toContain("WorkosCursorSessionToken");
  expect(capturedRequest?.commands[0]).not.toContain("/bin/sh");
});

it("renders helper failures as retryable unavailable state", async () => {
  const run = vi.fn(async () => [
    {
      command: "usage helper",
      stdout: "",
      stderr: "Cursor usage API returned HTTP 429",
      status: 3,
      durationMs: 1,
    },
  ]);

  const result = await loadCursorUsageLimits({
    pluginId: "pragma.cursor",
    pluginDir: "/plugin",
    config: undefined,
    project: null,
    sdk: { exec: { run } } as never,
    notify: () => {},
  });

  expect(result).toMatchObject({
    status: "unavailable",
    reason: "unsupported",
    message: expect.stringContaining("retry automatically"),
  });
});
