import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { selectModel, selectModelCandidates } from "./pick-model.ts";

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

describe("selectModel — quick", () => {
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
    expect(selectModel("quick", models, NOW)?.id).toBe("good-20260601");
  });

  it("falls back to reasoning models when no non-reasoning model fits", () => {
    const models = [
      model({ id: "too-big-20260601", reasoning: false, contextWindow: 1_000_000 }),
      model({ id: "reasoner-20260601", reasoning: true, contextWindow: 200_000 }),
    ];
    expect(selectModel("quick", models, NOW)?.id).toBe("reasoner-20260601");
  });

  it("picks the cheapest qualifying model (input + output)", () => {
    const models = [
      model({ id: "pricey-20260601", cost: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } }),
      model({ id: "cheap-20260601", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
    ];
    expect(selectModel("quick", models, NOW)?.id).toBe("cheap-20260601");
  });

  it("returns quick candidates in fallback order", () => {
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
    expect(selectModelCandidates("quick", models, NOW).map((candidate) => candidate.id)).toEqual([
      "cheap-20260601",
      "expensive-20260601",
    ]);
  });

  it("excludes models older than three months", () => {
    const models = [model({ id: "old-20251201" }), model({ id: "fresh-20260601" })];
    expect(selectModel("quick", models, NOW)?.id).toBe("fresh-20260601");
  });

  it("breaks cost ties toward the newer model", () => {
    const models = [model({ id: "older-20260401" }), model({ id: "newer-20260601" })];
    expect(selectModel("quick", models, NOW)?.id).toBe("newer-20260601");
  });

  it("returns undefined when nothing meets the quick context cap", () => {
    expect(
      selectModel("quick", [model({ id: "too-big-20260601", contextWindow: 1_000_000 })], NOW),
    ).toBeUndefined();
  });
});

describe("selectModel — standard", () => {
  it("requires a reasoning model above the context floor", () => {
    const models = [
      model({ id: "small-20260601", reasoning: true, contextWindow: 200_000 }),
      model({ id: "nonreasoning-20260601", reasoning: false, contextWindow: 400_000 }),
      model({ id: "good-20260601", reasoning: true, contextWindow: 400_000 }),
    ];
    expect(selectModel("standard", models, NOW)?.id).toBe("good-20260601");
  });

  it("treats the floor as exclusive", () => {
    const models = [model({ id: "exact-20260601", reasoning: true, contextWindow: 256_000 })];
    expect(selectModel("standard", models, NOW)).toBeUndefined();
  });
});
