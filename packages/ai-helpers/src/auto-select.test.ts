import { describe, expect, it, vi } from "vitest";

import {
  autoSelect,
  AutoSelectError,
  type AutoSelectInsights,
  type AutoSelectRequest,
  harnessMatchesAgent,
  headroom,
  parseAutoSelectRequest,
  reasoningForDifficulty,
  rowMatchesModel,
  tier,
} from "./auto-select.ts";
import type { HarnessInsight } from "./harness-insights.ts";
import type { ModelInsight } from "./model-insights.ts";

const LEVELS = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "max", name: "Max" },
];

function harnessRow(overrides: Partial<HarnessInsight>): HarnessInsight {
  return {
    agent: "Codex",
    model: "GPT-6 Astra",
    modelSlug: "gpt-6-astra",
    reasoningEffort: "max",
    accuracy: 58,
    accuracyCi95: 3,
    avgTaskSeconds: 2400,
    tokensPerSolve: 8e6,
    costPerSolveUsd: 17,
    trials: 330,
    date: "2026-09-03",
    ...overrides,
  };
}

function modelInsight(id: string, coding: number): ModelInsight {
  return {
    id,
    throughputTps: 100,
    latencyMs: 400,
    intelligence: coding,
    coding,
    costInput: 3,
    costOutput: 15,
  };
}

const INSIGHTS: AutoSelectInsights = {
  models: new Map([
    ["claudeopus55", modelInsight("anthropic/claude-opus-5.5", 70)],
    ["gpt6astra", modelInsight("openai/gpt-6-astra", 72)],
  ]),
  harness: [
    harnessRow({}),
    harnessRow({
      agent: "Claude Code",
      model: "Opus 5.5",
      modelSlug: null,
      accuracy: 55,
      avgTaskSeconds: 3600,
      tokensPerSolve: 12e6,
    }),
  ],
};

function request(overrides: Partial<AutoSelectRequest> = {}): AutoSelectRequest {
  return {
    endpoint: {
      baseUrl: "https://api.test",
      evaluatePath: "/v1/systemone",
      apiKey: "k",
      model: "jev-latest",
    },
    prompt: "Refactor the session layer across the server and client crates.",
    context: { project: "pragma", worktree: "refactor", branch: "refactor-sessions" },
    agents: [
      {
        id: "claude-code",
        name: "Claude Code",
        models: [
          { id: "opus", name: "Opus", canonicalId: "claude-opus-5-5", reasoning: LEVELS },
          {
            id: "haiku",
            name: "Haiku",
            canonicalId: "claude-haiku-4-5",
            reasoning: LEVELS.slice(0, 3),
          },
        ],
      },
      {
        id: "codex",
        name: "Codex",
        models: [{ id: "gpt-6-astra", name: "GPT-6 Astra", reasoning: LEVELS }],
      },
      { id: "cursor", name: "Cursor", models: [] },
    ],
    automode: {},
    limits: { promptChars: 6000, preferencesChars: 4000, timeoutMs: 5000 },
    ...overrides,
  };
}

/** A fetch double that records the request body and answers from `answers`. */
function jev(answers: (questions: Record<string, unknown>) => Record<string, unknown>) {
  const calls: Array<{ state: unknown; questions: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      state: unknown;
      questions: Record<string, unknown>;
    };
    calls.push(body);
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: answers(body.questions) }));
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

const choice = (picked: string, probabilities: Record<string, number>, confidence = 0.8) => ({
  type: "choice",
  choice: picked,
  probabilities,
  confidence,
});
const score = (value: number) => ({
  type: "score",
  score: value,
  probabilities: {},
  confidence: 0.9,
});

describe("autoSelect", () => {
  it("asks one fan-out request and maps the answers onto a selection", async () => {
    const double = jev(() => ({
      agent: choice("claude-code", { "claude-code": 0.7, codex: 0.2, cursor: 0.1 }),
      model_0: choice("opus", { opus: 0.9, haiku: 0.1 }),
      difficulty: score(3),
    }));
    const result = await autoSelect(request(), {
      loadInsights: async () => INSIGHTS,
      fetch: double.fetch,
    });

    expect(result).toMatchObject({
      agentId: "claude-code",
      modelId: "opus",
      // 0.75 across four levels lands on the third: "very hard" is what earns Max.
      reasoningId: "high",
      confidence: 0.8,
      lowConfidence: false,
      difficulty: 0.75,
      reason: "Claude Code 70% · Opus 90% · hard task → High",
      sources: { modelBenchmarks: true, harnessBenchmarks: true, usageLimits: false },
    });
    expect(double.calls).toHaveLength(1);
    // Only agents with a real model choice get a model question.
    expect(Object.keys(double.calls[0]!.questions).toSorted()).toEqual([
      "agent",
      "difficulty",
      "model_0",
    ]);
  });

  it("gives the System 1 model the benchmarks and the user's notes", async () => {
    const double = jev(() => ({
      agent: choice("codex", { "claude-code": 0.3, codex: 0.7 }),
      model_0: choice("opus", { opus: 1 }),
      difficulty: score(1),
    }));
    await autoSelect(
      request({
        automode: {
          global: "---\npriority: speed\n---\nPrefer Codex for CI.",
          project: "Use Claude Code for Rust.",
        },
      }),
      { loadInsights: async () => INSIGHTS, fetch: double.fetch },
    );
    const { state, questions } = double.calls[0]!;
    expect(state).toMatchObject({
      task: expect.stringContaining("Refactor"),
      where: { project: "pragma", branch: "refactor-sessions" },
      user_preferences: {
        priority: expect.stringContaining("fast"),
        project_notes: "Use Claude Code for Rust.",
        global_notes: "Prefer Codex for CI.",
      },
    });
    const agentCriteria = (questions.agent as { criteria: Record<string, any> }).criteria;
    expect(agentCriteria.codex.harness_benchmarks.versus_other_harnesses).toEqual({
      accuracy: "best",
      speed: "best",
      token_efficiency: "best",
    });
    expect(agentCriteria.cursor.harness_benchmarks).toMatch(/No harness benchmark data/);
    const modelCriteria = (questions.model_0 as { criteria: Record<string, any> }).criteria;
    expect(modelCriteria.opus.benchmarks.coding_index).toBe(70);
    expect(modelCriteria.opus.result_in_this_harness.accuracy_pct).toBe(55);
    expect(modelCriteria.haiku.benchmarks).toBe("No benchmark data.");
  });

  it("gives the System 1 model each agent's usage limits", async () => {
    const double = jev(() => ({
      agent: choice("codex", { "claude-code": 0.2, codex: 0.8 }),
      model_0: choice("haiku", { opus: 0.3, haiku: 0.7 }),
      difficulty: score(2),
    }));
    const base = request();
    const [claude, codex, cursor] = base.agents;
    const result = await autoSelect(
      request({
        agents: [
          {
            ...claude!,
            usage: [
              {
                provider: "anthropic",
                title: "Anthropic",
                status: "ready",
                limits: [
                  { title: "Weekly", percentUsed: 40, resetsInMs: 3 * 86_400_000, primary: false },
                  { title: "Session", percentUsed: 97.4, resetsInMs: 5_400_000, primary: true },
                  { title: "Extra", percentUsed: null, resetsInMs: null, primary: false },
                ],
              },
            ],
          },
          {
            ...codex!,
            usage: [
              {
                provider: "openai",
                title: "OpenAI",
                status: "unavailable",
                message: "Sign in to Codex",
                limits: [],
              },
            ],
          },
          cursor!,
        ],
      }),
      { loadInsights: async () => INSIGHTS, fetch: double.fetch },
    );
    expect(result.sources.usageLimits).toBe(true);
    const { questions } = double.calls[0]!;
    const agentCriteria = (questions.agent as { criteria: Record<string, any> }).criteria;
    expect(agentCriteria["claude-code"].usage_limits).toEqual([
      {
        provider: "Anthropic",
        headroom: "exhausted",
        limits: [
          { name: "Session", used_pct: 97, resets_in_hours: 1.5 },
          { name: "Weekly", used_pct: 40, resets_in_hours: 72 },
          { name: "Extra", used_pct: "unlimited" },
        ],
      },
    ]);
    expect(agentCriteria.codex.usage_limits).toEqual([
      { provider: "OpenAI", headroom: "unknown", note: "Sign in to Codex" },
    ]);
    expect(agentCriteria.cursor).not.toHaveProperty("usage_limits");
    const modelInstructions = (questions.model_0 as { instructions: Record<string, unknown> })
      .instructions;
    expect(modelInstructions.usage_limits).toEqual(agentCriteria["claude-code"].usage_limits);
  });

  it("applies automode.md filters before asking and skips the agent question for one survivor", async () => {
    const double = jev(() => ({ difficulty: score(0) }));
    const result = await autoSelect(
      request({ automode: { project: "---\nagents: [codex]\n---\n" } }),
      { loadInsights: async () => INSIGHTS, fetch: double.fetch },
    );
    expect(result).toMatchObject({
      agentId: "codex",
      modelId: "gpt-6-astra",
      reasoningId: "low",
      confidence: 1,
      reason: "Codex · GPT-6 Astra · trivial task → Low",
    });
    expect(Object.keys(double.calls[0]!.questions)).toEqual(["difficulty"]);
  });

  it("flags a low-confidence pick and reports automode.md warnings", async () => {
    const double = jev(() => ({
      agent: choice("cursor", { "claude-code": 0.34, codex: 0.33, cursor: 0.33 }, 0.1),
      model_0: choice("opus", { opus: 0.5, haiku: 0.5 }),
      difficulty: score(2),
    }));
    const result = await autoSelect(request({ automode: { global: "---\nprefer: x\n---\n" } }), {
      loadInsights: async () => INSIGHTS,
      fetch: double.fetch,
    });
    expect(result).toMatchObject({
      agentId: "cursor",
      modelId: null,
      reasoningId: null,
      lowConfidence: true,
    });
    expect(result.warnings).toEqual(['global automode.md: unknown frontmatter key "prefer"']);
  });

  it("refuses when every agent is excluded", async () => {
    await expect(
      autoSelect(request({ automode: { global: "---\nagents:\n  exclude: ['*']\n---\n" } }), {
        loadInsights: async () => INSIGHTS,
      }),
    ).rejects.toThrow(/Available agents: claude-code, codex, cursor\./);
  });

  it("works with no benchmark data at all", async () => {
    const double = jev(() => ({
      agent: choice("codex", { "claude-code": 0.4, codex: 0.6 }),
      model_0: choice("haiku", { opus: 0.4, haiku: 0.6 }),
      difficulty: score(2),
    }));
    const result = await autoSelect(request({ prompt: "" }), {
      loadInsights: async () => ({ models: new Map(), harness: [] }),
      fetch: double.fetch,
    });
    expect(result.sources).toEqual({
      modelBenchmarks: false,
      harnessBenchmarks: false,
      usageLimits: false,
    });
    expect((double.calls[0]!.state as { task: string }).task).toMatch(/No prompt was written/);
  });
});

describe("parseAutoSelectRequest", () => {
  it("defaults the optional fields", () => {
    const { endpoint, agents, limits } = request();
    expect(parseAutoSelectRequest(JSON.stringify({ endpoint, agents, limits }))).toEqual({
      endpoint,
      agents,
      limits,
      prompt: "",
      context: {},
      automode: {},
    });
  });

  it("rejects a request missing its key, agents, or limits", () => {
    const { endpoint, agents, limits } = request();
    for (const partial of [
      { agents, limits },
      { endpoint: { ...endpoint, apiKey: "" }, agents, limits },
      { endpoint, limits },
      { endpoint, agents },
    ]) {
      expect(() => parseAutoSelectRequest(JSON.stringify(partial))).toThrow(AutoSelectError);
    }
  });
});

describe("matching", () => {
  it("matches harness labels to agents by name or id", () => {
    expect(harnessMatchesAgent("Claude Code", { id: "claude-code", name: "Claude Code" })).toBe(
      true,
    );
    expect(harnessMatchesAgent("Grok Build", { id: "grok", name: "Grok" })).toBe(true);
    expect(harnessMatchesAgent("Codex", { id: "cursor", name: "Cursor" })).toBe(false);
  });

  it("matches leaderboard models through aliases and slugs", () => {
    const opus = { id: "opus", name: "Opus", canonicalId: "claude-opus-5-5", reasoning: [] };
    expect(rowMatchesModel(harnessRow({ model: "Opus 5.5", modelSlug: null }), opus)).toBe(true);
    expect(rowMatchesModel(harnessRow({ model: "Opus 5", modelSlug: "claude-opus-5" }), opus)).toBe(
      false,
    );
    const astra = { id: "openai/gpt-6-astra", name: "GPT-6 Astra", reasoning: [] };
    expect(rowMatchesModel(harnessRow({}), astra)).toBe(true);
  });
});

const usageAt = (percents: (number | null)[], status: "ready" | "unknown" = "ready") => ({
  provider: "p",
  title: "P",
  status,
  limits: percents.map((percentUsed, index) => ({
    title: `l${index}`,
    percentUsed,
    resetsInMs: null,
    primary: index === 0,
  })),
});

describe("headroom", () => {
  it("tiers by the most-used finite limit", () => {
    expect(headroom(usageAt([10, 30]))).toBe("plenty");
    expect(headroom(usageAt([10, 60]))).toBe("some");
    expect(headroom(usageAt([85, 10]))).toBe("low");
    expect(headroom(usageAt([95]))).toBe("exhausted");
    expect(headroom(usageAt([null]))).toBe("plenty");
    expect(headroom(usageAt([99], "unknown"))).toBe("unknown");
  });
});

describe("tier", () => {
  it("ranks in either direction", () => {
    expect(tier(10, [10, 5, 1], true)).toBe("best");
    expect(tier(1, [10, 5, 1], false)).toBe("best");
    expect(tier(5, [10, 7, 5, 1], true)).toBe("below median");
    expect(tier(3, [3], true)).toBe("only one measured");
  });
});

describe("reasoningForDifficulty", () => {
  it("spreads difficulty across the available levels", () => {
    expect(reasoningForDifficulty(LEVELS, 0)?.id).toBe("low");
    expect(reasoningForDifficulty(LEVELS, 0.5)?.id).toBe("high");
    expect(reasoningForDifficulty(LEVELS, 1)?.id).toBe("max");
    expect(reasoningForDifficulty([], 1)).toBeNull();
  });
});
