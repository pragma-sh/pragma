import { expect, it, vi } from "vitest";

import { claudeCodeAgentPlugin, loadClaudeUsageLimits, parseClaudeUsage } from "./pragma-plugin";

it("links to Claude's usage dashboard", () => {
  expect(claudeCodeAgentPlugin.usageLimits?.[0]?.dashboardUrl).toBe(
    "https://claude.ai/new#settings/usage",
  );
});

it("normalizes Claude plan usage windows", () => {
  const observedAt = Date.parse("2026-07-14T00:00:00Z");
  const result = parseClaudeUsage(
    {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42.5, resets_at: "2026-07-14T02:00:00Z" },
        seven_day: { utilization: 18, resets_at: "2026-07-20T00:00:00Z" },
        seven_day_opus: null,
        model_scoped: [
          {
            display_name: "Claude Fable",
            utilization: 105,
            resets_at: "2026-07-15T00:00:00Z",
          },
        ],
      },
    },
    observedAt,
  );

  expect(result).toEqual({
    status: "ready",
    observedAt,
    limits: [
      {
        id: "five-hour",
        title: "5-hour limit",
        used: 42.5,
        limit: 100,
        resetsInMs: 2 * 60 * 60 * 1000,
      },
      {
        id: "seven-day",
        title: "Weekly limit",
        used: 18,
        limit: 100,
        resetsInMs: 6 * 24 * 60 * 60 * 1000,
      },
      {
        id: "model-0",
        title: "Claude Fable",
        used: 100,
        limit: 100,
        resetsInMs: 24 * 60 * 60 * 1000,
      },
    ],
  });
});

it("requires subscription rate limits and a five-hour window", () => {
  expect(parseClaudeUsage({ rate_limits_available: false, rate_limits: null }, 1)).toMatchObject({
    status: "unavailable",
    reason: "authentication-required",
  });
  expect(
    parseClaudeUsage(
      {
        rate_limits_available: true,
        rate_limits: { seven_day: { utilization: 25, resets_at: null } },
      },
      1,
    ),
  ).toMatchObject({ status: "unavailable", reason: "unsupported" });
});

it("loads usage through Claude Code without handling OAuth credentials", async () => {
  let capturedRequest: { cwd: string; commands: string[] } | undefined;
  const run = vi.fn(async (request: { cwd: string; commands: string[] }) => {
    capturedRequest = request;
    return [
      {
        command: "claude usage",
        stdout: `${JSON.stringify({ type: "system", subtype: "init" })}\n${JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "pragma-usage",
            response: {
              rate_limits_available: true,
              rate_limits: { five_hour: { utilization: 30, resets_at: null } },
            },
          },
        })}\n`,
        stderr: "",
        status: 0,
        durationMs: 1,
      },
    ];
  });

  const result = await loadClaudeUsageLimits({
    pluginId: "pragma.claude-code",
    pluginDir: "/Applications/Pragma App/plugins/claude-code",
    config: undefined,
    project: { id: "p", name: "Project", path: "/project" },
    sdk: { exec: { run } } as never,
    notify: () => {},
  });

  expect(result).toMatchObject({ status: "ready", limits: [{ id: "five-hour", used: 30 }] });
  expect(capturedRequest).toEqual({
    cwd: "/project",
    commands: [expect.stringContaining('"subtype":"get_usage"')],
  });
  expect(capturedRequest?.commands[0]).toContain("--safe-mode");
  expect(capturedRequest?.commands[0]).not.toContain("accessToken");
});
