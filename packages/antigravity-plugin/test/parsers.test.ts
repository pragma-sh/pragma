import { describe, expect, test } from "vitest";

import { latestTurn, parseTranscript } from "../src/hook/transcript";
import {
  antigravityArgs,
  antigravityResume,
  parseAntigravityModels,
  parseAntigravityUsage,
} from "../src/pragma-plugin";

describe("transcript", () => {
  const lines = [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "<USER_REQUEST>\nOld\n</USER_REQUEST>",
    },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: "old reply" },
    {
      step_index: 2,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content:
        "<USER_REQUEST>\nNew prompt\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>",
    },
    {
      step_index: 3,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command" }],
    },
    { step_index: 4, source: "MODEL", type: "GENERIC", content: "Command output" },
    { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", content: "done" },
  ];
  const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\nnot json\n`;

  test("reads only the newest user turn", () => {
    expect(latestTurn(parseTranscript(text))).toEqual({
      userStep: 2,
      prompt: "New prompt",
      assistantText: "done",
    });
  });
});

describe("launch arguments", () => {
  test("permission modes map to agy flags", () => {
    expect(antigravityArgs.permissionMode?.("default")).toEqual([]);
    expect(antigravityArgs.permissionMode?.("plan")).toEqual(["--mode", "plan"]);
    expect(antigravityArgs.permissionMode?.("skip")).toEqual(["--dangerously-skip-permissions"]);
    const ask = antigravityArgs.permissionMode?.("ask") ?? [];
    expect(ask[0]).toBe("--settings");
    expect(JSON.parse(ask[1] ?? "{}")).toEqual({ permissions: { ask: ["command(*)"] } });
  });

  test("resume reopens the conversation with the stored selection", () => {
    const argv = antigravityResume(
      {
        harnessSessionId: "conv-1",
        selection: { modelId: "gemini-3.8-flash-low", permissionModeId: "plan" },
        cwd: "/w",
      } as Parameters<typeof antigravityResume>[0],
      {} as Parameters<typeof antigravityResume>[1],
    );
    expect(argv).toEqual([
      "agy",
      "--model",
      "gemini-3.8-flash-low",
      "--mode",
      "plan",
      "--conversation",
      "conv-1",
    ]);
  });
});

test("models parse from `agy models`", () => {
  const stdout =
    "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
  expect(parseAntigravityModels(stdout)).toEqual([
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  ]);
});

describe("usage limits", () => {
  const observedAt = Date.parse("2026-11-21T02:00:00Z");
  const report = {
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                id: "gemini-weekly",
                window: "weekly",
                remaining_fraction: 0.75,
                reset_time: "2026-11-28T02:00:00Z",
              },
              {
                id: "gemini-5h",
                window: "5h",
                remaining_fraction: 1,
                reset_time: "2026-11-21T07:00:00Z",
              },
            ],
          },
        ],
      },
    },
  };

  test("buckets become percent limits with reset times", () => {
    const result = parseAntigravityUsage(JSON.stringify(report), observedAt);
    expect(result).toEqual({
      status: "ready",
      observedAt,
      limits: [
        {
          id: "gemini-weekly",
          title: "Gemini Models · Weekly",
          used: 25,
          limit: 100,
          resetsInMs: 7 * 86_400_000,
        },
        {
          id: "gemini-5h",
          title: "Gemini Models · 5-hour",
          used: 0,
          limit: 100,
          resetsInMs: 5 * 3_600_000,
        },
      ],
    });
  });

  test("a failed command asks the user to sign in", () => {
    expect(parseAntigravityUsage(JSON.stringify({ status: "ERROR" }), observedAt)).toMatchObject({
      status: "unavailable",
      reason: "authentication-required",
    });
  });

  test("unparseable output is a regression, not a quiet state", () => {
    expect(() => parseAntigravityUsage("panic", observedAt)).toThrow();
  });
});
