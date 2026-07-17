import { expect, it, vi } from "vitest";

import { codexAgentPlugin, parseCodexModels } from "./pragma-plugin";
import {
  extractCodexUsageLimits,
  loadCodexUsageLimits,
  parseCodexUsageLimits,
} from "./usage-limits";

it("uses Codex as the integration display name", () => {
  expect(codexAgentPlugin.name).toBe("Codex");
  expect(codexAgentPlugin.agents?.[0]?.name).toBe("Codex");
  expect(codexAgentPlugin.usageLimits?.[0]?.title).toBe("Codex");
});

it("parses visible Codex models and reasoning levels", () => {
  expect(
    parseCodexModels(
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6-Sol",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }],
          },
          { slug: "internal", display_name: "Internal", visibility: "hide" },
        ],
      }),
    ),
  ).toEqual([
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      reasoning: [
        { id: "low", name: "Low" },
        { id: "xhigh", name: "Extra High" },
      ],
    },
  ]);
});

it("returns no models for malformed output", () => {
  expect(parseCodexModels("not-json")).toEqual([]);
});

it("builds model, reasoning, and permission arguments", () => {
  const agent = codexAgentPlugin.agents?.[0];
  expect(agent?.launch.command).toEqual(["codex", "--enable", "default_mode_request_user_input"]);
  expect(agent?.args.modelReasoning?.("gpt-5.6-sol", "high")).toEqual([
    "--model",
    "gpt-5.6-sol",
    "--config",
    'model_reasoning_effort="high"',
  ]);
  expect(agent?.args.permissionMode("on-request")).toEqual(["--ask-for-approval", "on-request"]);
});

it("normalizes Codex primary and weekly rate limits", () => {
  const observedAt = 1_800_000_000_000;
  expect(
    parseCodexUsageLimits(
      {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: 1_800_003_600,
          },
          secondary: {
            usedPercent: 75,
            windowDurationMins: 10_080,
            resetsAt: 1_800_086_400,
          },
        },
      },
      observedAt,
    ),
  ).toEqual({
    status: "ready",
    observedAt,
    limits: [
      {
        id: "codex-primary",
        title: "5-hour limit",
        used: 25,
        limit: 100,
        resetsInMs: 3_600_000,
      },
      {
        id: "codex-secondary",
        title: "Weekly limit",
        used: 75,
        limit: 100,
        resetsInMs: 86_400_000,
      },
    ],
  });
});

it("returns unsupported when no usage windows exist", () => {
  expect(parseCodexUsageLimits({ rateLimits: {} }, 1)).toMatchObject({
    status: "unavailable",
    reason: "unsupported",
  });
});

it("requests usage through Codex app-server without exposing credentials", async () => {
  let request: { cwd: string; commands: string[] } | undefined;
  const run = vi.fn(async (value: { cwd: string; commands: string[] }) => {
    request = value;
    return [
      {
        command: value.commands[0] ?? "",
        stdout: JSON.stringify({
          id: 2,
          result: {
            rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } },
          },
        }),
        stderr: "",
        status: 0,
        durationMs: 1,
      },
    ];
  });

  const result = await loadCodexUsageLimits({
    pluginId: "pragma.codex",
    config: undefined,
    project: { id: "p", name: "Project", path: "/project" },
    sdk: { exec: { run } } as never,
    notify: () => {},
  });

  expect(result).toMatchObject({ status: "ready", limits: [{ used: 10 }] });
  expect(request?.cwd).toBe("/project");
  expect(request?.commands[0]).toContain("codex app-server --stdio");
  expect(request?.commands[0]).toContain("account/rateLimits/read");
  expect(request?.commands[0]).toContain("sleep 3");
  expect(request?.commands[0]).not.toContain("python");
});

it("maps app-server authentication errors", () => {
  expect(
    extractCodexUsageLimits(
      JSON.stringify({ id: 2, error: { message: "Login required for this account" } }),
      1,
    ),
  ).toMatchObject({ status: "unavailable", reason: "authentication-required" });
});

it("clears status when watcher-owned session exits", async () => {
  const watcher = codexAgentPlugin.watchers?.[0];
  const controller = new AbortController();
  const report = vi.fn(async () => {});
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
                  agent: "pragma.codex",
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
    agentId: "pragma.codex",
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
  expect(report).toHaveBeenCalledWith({
    agent: "pragma.codex",
    tabId: "tab-1",
    worktreeId: "worktree-1",
    status: "cleared",
    attentionKind: null,
  });
});

it("answers questions without applying command decisions", async () => {
  const watcher = codexAgentPlugin.watchers?.[0];
  const controller = new AbortController();
  const sendKeys = vi.fn(async () => {});
  const context = {
    sdk: {
      agents: {
        connect: async () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "agentDecision",
              decision: {
                agent: "pragma.codex",
                worktreeId: "worktree-1",
                tabId: "tab-1",
                requestId: "command-1",
                approved: true,
              },
            };
            yield {
              type: "agent",
              agent: "pragma.codex",
              worktreeId: "worktree-1",
              tabId: "tab-1",
              status: "attention",
              attentionKind: "question",
              requestId: "question-1",
              question: "Choose Red or Blue?",
              options: [{ label: "Red" }, { label: "Blue" }],
            };
            yield {
              type: "agentAnswer",
              answer: {
                agent: "pragma.codex",
                worktreeId: "worktree-1",
                tabId: "tab-1",
                requestId: "question-1",
                answer: "Blue",
                dismissed: false,
              },
            };
            controller.abort();
          },
        }),
        report: async () => {},
      },
    },
    agentId: "pragma.codex",
    config: undefined,
    session: { id: "session-1", tabId: "tab-1", worktreeId: "worktree-1" },
    output: (async function* () {})(),
    sendKeys,
    reportMessage: async () => {},
    signal: controller.signal,
  };

  await watcher?.watch(context as never);

  expect(sendKeys).toHaveBeenCalledTimes(1);
  expect(sendKeys).toHaveBeenCalledWith("2");
});
