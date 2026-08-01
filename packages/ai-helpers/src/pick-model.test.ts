import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { ModelInsight, ModelInsights } from "./model-insights.ts";
import { insightKey } from "./model-insights.ts";
import { priceCeiling, quantile, selectModel, selectModelCandidates } from "./pick-model.ts";

const NOW = new Date(Date.UTC(2026, 5, 22));

function model(overrides: Partial<Model<Api>> & Pick<Model<Api>, "id">): Model<Api> {
  return {
    name: overrides.id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  } as Model<Api>;
}

/** Build an insight lookup keyed the same way {@link insightFor} reads it. */
function insights(entries: Record<string, Partial<ModelInsight>>): ModelInsights {
  return new Map(
    Object.entries(entries).map(([id, insight]) => [
      insightKey(id),
      {
        id,
        throughputTps: null,
        latencyMs: null,
        intelligence: null,
        coding: null,
        costInput: null,
        costOutput: null,
        ...insight,
      },
    ]),
  );
}

/** Anchor entries so the ceilings resolve from data, not the offline fallback. */
const SONNET_ANCHOR = {
  "anthropic/claude-sonnet-5": { costInput: 2, costOutput: 10 },
} as const;
const OPUS_ANCHOR = {
  "anthropic/claude-opus-5": { costInput: 5, costOutput: 25 },
} as const;

/** A model priced exactly at the Opus anchor — over mid-tier, within frontier. */
function opusPriced(id: string): Model<Api> {
  return model({
    id,
    reasoning: true,
    cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
  });
}

describe("quantile", () => {
  it("interpolates between samples", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10, 0, 5], 0)).toBe(0);
    expect(quantile([10, 0, 5], 1)).toBe(10);
  });

  it("returns null for an empty sample", () => {
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe("selectModel — fast", () => {
  it("prefers a non-reasoning model within the context cap", () => {
    const models = [
      model({
        id: "reasoner-20260601",
        reasoning: true,
        contextWindow: 200_000,
        cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
      }),
      model({ id: "too-big-20260601", reasoning: false, contextWindow: 1_000_000 }),
      model({ id: "good-20260601", reasoning: false, contextWindow: 200_000 }),
    ];
    expect(selectModel("fast", models, { now: NOW })?.id).toBe("good-20260601");
  });

  it("falls back to reasoning models when no non-reasoning model fits", () => {
    const models = [
      model({ id: "too-big-20260601", reasoning: false, contextWindow: 1_000_000 }),
      model({ id: "reasoner-20260601", reasoning: true, contextWindow: 200_000 }),
    ];
    expect(selectModel("fast", models, { now: NOW })?.id).toBe("reasoner-20260601");
  });

  it("ranks on measured throughput ahead of price", () => {
    const models = [
      model({
        id: "slow-cheap-20260601",
        cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
      }),
      model({
        id: "quick-dear-20260601",
        cost: { input: 3, output: 3, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    const data = insights({
      "anthropic/slow-cheap": { throughputTps: 20 },
      "anthropic/quick-dear": { throughputTps: 300 },
    });
    expect(selectModel("fast", models, { now: NOW, insights: data })?.id).toBe(
      "quick-dear-20260601",
    );
  });

  it("ranks unmeasured models below every measured one", () => {
    const models = [model({ id: "unmeasured-20260601" }), model({ id: "measured-20260601" })];
    const data = insights({ "anthropic/measured": { throughputTps: 50 } });
    expect(
      selectModelCandidates("fast", models, { now: NOW, insights: data }).map((c) => c.id),
    ).toEqual(["measured-20260601", "unmeasured-20260601"]);
  });

  it("falls back to latency when no throughput is published", () => {
    const models = [model({ id: "laggy-20260601" }), model({ id: "snappy-20260601" })];
    const data = insights({
      "anthropic/laggy": { latencyMs: 4000 },
      "anthropic/snappy": { latencyMs: 300 },
    });
    expect(selectModel("fast", models, { now: NOW, insights: data })?.id).toBe("snappy-20260601");
  });

  it("drops the pool's least capable models before ranking on speed", () => {
    // Six models so the percentile cut applies; speed runs inverse to
    // capability, so the winner is whatever survives the P40 intelligence floor.
    const models = [
      model({ id: "toy-20260601" }),
      model({ id: "a-20260601" }),
      model({ id: "b-20260601" }),
      model({ id: "c-20260601" }),
      model({ id: "d-20260601" }),
      model({ id: "e-20260601" }),
    ];
    const data = insights({
      "anthropic/toy": { intelligence: 3, throughputTps: 900 },
      "anthropic/a": { intelligence: 30, throughputTps: 100 },
      "anthropic/b": { intelligence: 40, throughputTps: 90 },
      "anthropic/c": { intelligence: 45, throughputTps: 80 },
      "anthropic/d": { intelligence: 50, throughputTps: 70 },
      "anthropic/e": { intelligence: 55, throughputTps: 60 },
    });
    // P40 of [3, 30, 40, 45, 50, 55] is 40, so both `toy` and `a` are cut.
    expect(selectModel("fast", models, { now: NOW, insights: data })?.id).toBe("b-20260601");
  });

  it("keeps a cut that would otherwise empty the pool", () => {
    const models = Array.from({ length: 6 }, (_, index) => model({ id: `m${index}-20260601` }));
    // Every model is unbenchmarked, so the intelligence floor has nothing to cut.
    expect(selectModelCandidates("fast", models, { now: NOW })).toHaveLength(6);
  });

  it("picks the cheapest qualifying model when modelgrep knows nothing", () => {
    const models = [
      model({ id: "pricey-20260601", cost: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }),
      model({ id: "cheap-20260601", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
    ];
    expect(selectModel("fast", models, { now: NOW })?.id).toBe("cheap-20260601");
  });

  it("returns candidates in fallback order", () => {
    const models = [
      model({
        id: "expensive-20260601",
        reasoning: true,
        cost: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
      }),
      model({
        id: "cheap-20260601",
        reasoning: true,
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    expect(selectModelCandidates("fast", models, { now: NOW }).map((c) => c.id)).toEqual([
      "cheap-20260601",
      "expensive-20260601",
    ]);
  });

  it("excludes models older than three months", () => {
    const models = [model({ id: "old-20251201" }), model({ id: "fresh-20260601" })];
    expect(selectModel("fast", models, { now: NOW })?.id).toBe("fresh-20260601");
  });

  it("breaks near-equal scores toward the newer model", () => {
    const models = [model({ id: "older-20260401" }), model({ id: "newer-20260601" })];
    expect(selectModel("fast", models, { now: NOW })?.id).toBe("newer-20260601");
  });

  it("prefers the newer model when speeds land in the same band", () => {
    const models = [
      model({ id: "older-20260401" }),
      model({ id: "newer-20260501" }),
      model({ id: "sluggish-20260601" }),
    ];
    // 300 vs 299 is within one 5% band of the pool range; 10 is not.
    const data = insights({
      "anthropic/older": { throughputTps: 300 },
      "anthropic/newer": { throughputTps: 299 },
      "anthropic/sluggish": { throughputTps: 10 },
    });
    expect(selectModel("fast", models, { now: NOW, insights: data })?.id).toBe("newer-20260501");
  });

  it("returns undefined when nothing meets the fast context cap", () => {
    expect(
      selectModel("fast", [model({ id: "too-big-20260601", contextWindow: 1_000_000 })], {
        now: NOW,
      }),
    ).toBeUndefined();
  });
});

describe("selectModel — standard", () => {
  it("requires a reasoning model at or above the context floor", () => {
    const models = [
      model({ id: "small-20260601", reasoning: true, contextWindow: 64_000 }),
      model({ id: "nonreasoning-20260601", reasoning: false, contextWindow: 400_000 }),
      model({ id: "good-20260601", reasoning: true, contextWindow: 400_000 }),
    ];
    expect(selectModel("standard", models, { now: NOW })?.id).toBe("good-20260601");
  });

  it("treats the context floor as inclusive", () => {
    const models = [model({ id: "exact-20260601", reasoning: true, contextWindow: 128_000 })];
    expect(selectModel("standard", models, { now: NOW })?.id).toBe("exact-20260601");
  });

  it("balances capability against price instead of buying the flagship", () => {
    const models = [
      model({
        id: "flagship-20260601",
        reasoning: true,
        cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
      }),
      model({
        id: "balanced-20260601",
        reasoning: true,
        cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
      }),
      model({
        id: "budget-20260601",
        reasoning: true,
        cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    const data = insights({
      "anthropic/flagship": { intelligence: 60 },
      "anthropic/balanced": { intelligence: 52 },
      "anthropic/budget": { intelligence: 20 },
    });
    expect(selectModel("standard", models, { now: NOW, insights: data })?.id).toBe(
      "balanced-20260601",
    );
  });

  it("refuses anything above the mid-tier ceiling, however capable", () => {
    const models = [
      opusPriced("frontier-20260601"),
      model({
        id: "midtier-20260601",
        reasoning: true,
        cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    const data = insights({
      ...SONNET_ANCHOR,
      "anthropic/frontier": { intelligence: 99 },
      "anthropic/midtier": { intelligence: 20 },
    });
    const ids = selectModelCandidates("standard", models, { now: NOW, insights: data }).map(
      (c) => c.id,
    );
    expect(ids).toEqual(["midtier-20260601"]);
  });

  it("judges an unbenchmarked model on price rather than ranking it last", () => {
    const models = [
      model({
        id: "unknown-20260601",
        reasoning: true,
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      }),
      model({
        id: "known-dear-20260601",
        reasoning: true,
        cost: { input: 6, output: 12, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    const data = insights({ "anthropic/known-dear": { intelligence: 55 } });
    expect(selectModel("standard", models, { now: NOW, insights: data })?.id).toBe(
      "unknown-20260601",
    );
  });
});

describe("priceCeiling", () => {
  it("resolves from the anchor's live price, with headroom", () => {
    // Sonnet at 2 + 10 blended, plus the 10% "roughly" tolerance.
    expect(priceCeiling("sonnet", insights(SONNET_ANCHOR))).toBeCloseTo(13.2);
    expect(priceCeiling("opus", insights(OPUS_ANCHOR))).toBeCloseTo(33);
  });

  it("tracks the anchor when its price changes", () => {
    const repriced = insights({ "anthropic/claude-opus-5": { costInput: 3, costOutput: 12 } });
    expect(priceCeiling("opus", repriced)).toBeCloseTo(16.5);
  });

  it("falls through to the next anchor id, then to the offline fallback", () => {
    const older = insights({ "anthropic/claude-sonnet-4.5": { costInput: 3, costOutput: 15 } });
    expect(priceCeiling("sonnet", older)).toBeCloseTo(19.8);
    expect(priceCeiling("sonnet", new Map())).toBeCloseTo(19.8);
    expect(priceCeiling("opus", new Map())).toBeCloseTo(33);
  });

  it("ignores an anchor entry with no pricing", () => {
    const priceless = insights({ "anthropic/claude-opus-5": { intelligence: 60 } });
    expect(priceCeiling("opus", priceless)).toBeCloseTo(33);
  });
});

describe("selectModel — high", () => {
  it("buys the most capable model the frontier ceiling allows", () => {
    const models = [
      opusPriced("frontier-20260601"),
      model({
        id: "midtier-20260601",
        reasoning: true,
        cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    const data = insights({
      ...OPUS_ANCHOR,
      "anthropic/frontier": { intelligence: 60 },
      "anthropic/midtier": { intelligence: 45 },
    });
    expect(selectModel("high", models, { now: NOW, insights: data })?.id).toBe("frontier-20260601");
  });

  it("still refuses anything above the frontier ceiling", () => {
    const models = [
      model({
        id: "ultra-20260601",
        reasoning: true,
        cost: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0 },
      }),
      opusPriced("frontier-20260601"),
    ];
    const data = insights({
      ...OPUS_ANCHOR,
      "anthropic/ultra": { intelligence: 99 },
      "anthropic/frontier": { intelligence: 60 },
    });
    const ids = selectModelCandidates("high", models, { now: NOW, insights: data }).map(
      (c) => c.id,
    );
    expect(ids).toEqual(["frontier-20260601"]);
  });

  it("returns nothing when every model breaches the ceiling", () => {
    const models = [
      model({
        id: "ultra-20260601",
        reasoning: true,
        cost: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    expect(
      selectModelCandidates("high", models, { now: NOW, insights: insights(OPUS_ANCHOR) }),
    ).toEqual([]);
  });

  it("does not trade capability for price under the ceiling", () => {
    const models = [
      opusPriced("capable-20260601"),
      model({
        id: "cheap-20260601",
        reasoning: true,
        cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    const data = insights({
      ...OPUS_ANCHOR,
      "anthropic/capable": { intelligence: 60 },
      "anthropic/cheap": { intelligence: 25 },
    });
    expect(selectModel("high", models, { now: NOW, insights: data })?.id).toBe("capable-20260601");
  });

  it("falls back to the newest model when nothing is benchmarked", () => {
    const models = [
      model({ id: "older-20260401", reasoning: true }),
      model({ id: "newer-20260601", reasoning: true }),
    ];
    expect(selectModel("high", models, { now: NOW })?.id).toBe("newer-20260601");
  });
});
