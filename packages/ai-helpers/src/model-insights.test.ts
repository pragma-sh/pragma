import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MODEL_INSIGHTS } from "./constants.ts";
import { indexInsights, insightFor, insightKey, loadModelInsights } from "./model-insights.ts";

const NOW = new Date(Date.UTC(2026, 6, 30, 12));

async function tempCachePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pragma-insights-"));
  return join(dir, "model-insights.json");
}

describe("insightKey", () => {
  it("collapses pi and modelgrep dialects onto the same key", () => {
    expect(insightKey("claude-sonnet-4-5-20250929")).toBe(
      insightKey("anthropic/claude-sonnet-4.5"),
    );
    expect(insightKey("gpt-5-2025-08-07")).toBe(insightKey("openai/gpt-5"));
    expect(insightKey("claude-3-5-haiku-latest")).toBe(insightKey("anthropic/claude-3.5-haiku"));
  });

  it("ignores serving variants", () => {
    expect(insightKey("anthropic/claude-opus-5:batch")).toBe(insightKey("anthropic/claude-opus-5"));
    expect(insightKey("qwen/qwen3-coder:free")).toBe(insightKey("qwen/qwen3-coder"));
  });

  it("keeps distinct models distinct", () => {
    expect(insightKey("anthropic/claude-opus-5")).not.toBe(
      insightKey("anthropic/claude-haiku-4.5"),
    );
  });
});

describe("indexInsights", () => {
  it("reads throughput, latency, and benchmark scores", () => {
    const index = indexInsights([
      {
        id: "openai/gpt-5.5",
        performance: { throughput_tps: 120, latency_ms: 400, uptime: 100 },
        pricing: { input: 5, output: 30, cache_read: 0.5 },
        benchmarks: { artificial_analysis: { intelligence: 54.8, coding: 74.9 } },
      },
    ]);
    expect(index.get(insightKey("gpt-5.5"))).toEqual({
      id: "openai/gpt-5.5",
      throughputTps: 120,
      latencyMs: 400,
      intelligence: 54.8,
      coding: 74.9,
      costInput: 5,
      costOutput: 30,
    });
  });

  it("keeps the richest entry when variants collapse to one key", () => {
    const index = indexInsights([
      { id: "anthropic/claude-opus-5:batch", performance: {}, benchmarks: {} },
      {
        id: "anthropic/claude-opus-5",
        performance: { throughput_tps: 60 },
        benchmarks: { artificial_analysis: { intelligence: 60.7 } },
      },
    ]);
    expect(index.size).toBe(1);
    expect(index.get(insightKey("claude-opus-5"))?.throughputTps).toBe(60);
  });

  it("skips malformed entries instead of throwing", () => {
    expect(indexInsights([null, 42, {}, { id: 7 }]).size).toBe(0);
  });

  it("normalizes missing metrics to null rather than dropping the model", () => {
    const index = indexInsights([{ id: "anthropic/claude-opus-5" }]);
    expect(index.get(insightKey("claude-opus-5"))).toMatchObject({
      throughputTps: null,
      intelligence: null,
    });
  });
});

describe("insightFor", () => {
  it("matches a pi model id against the modelgrep index", () => {
    const index = indexInsights([
      { id: "anthropic/claude-sonnet-4.5", performance: { throughput_tps: 55 } },
    ]);
    expect(insightFor(index, { id: "claude-sonnet-4-5-20250929" })?.throughputTps).toBe(55);
    expect(insightFor(index, { id: "some-local-model" })).toBeUndefined();
  });
});

describe("loadModelInsights", () => {
  it("serves a fresh cache without touching the network", async () => {
    const cachePath = await tempCachePath();
    await writeFile(
      cachePath,
      JSON.stringify({
        version: MODEL_INSIGHTS.cacheVersion,
        fetchedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
        insights: {
          [insightKey("claude-opus-5")]: {
            id: "anthropic/claude-opus-5",
            throughputTps: 60,
            latencyMs: null,
            intelligence: 60.7,
            coding: null,
          },
        },
      }),
      "utf8",
    );

    const insights = await loadModelInsights({ now: NOW, cachePath, offline: true });
    expect(insights.size).toBe(1);
    expect(insightFor(insights, { id: "claude-opus-5-20260101" })?.intelligence).toBe(60.7);
  });

  it("ignores a cache past its TTL", async () => {
    const cachePath = await tempCachePath();
    await writeFile(
      cachePath,
      JSON.stringify({
        version: MODEL_INSIGHTS.cacheVersion,
        fetchedAt: new Date(NOW.getTime() - 48 * 3_600_000).toISOString(),
        insights: { x: { id: "x" } },
      }),
      "utf8",
    );
    expect((await loadModelInsights({ now: NOW, cachePath, offline: true })).size).toBe(0);
  });

  it("returns an empty lookup for a missing or corrupt cache when offline", async () => {
    const cachePath = await tempCachePath();
    expect((await loadModelInsights({ now: NOW, cachePath, offline: true })).size).toBe(0);

    await writeFile(cachePath, "{not json", "utf8");
    expect((await loadModelInsights({ now: NOW, cachePath, offline: true })).size).toBe(0);
  });

  it("discards a cache written by an older schema", async () => {
    const cachePath = await tempCachePath();
    await writeFile(
      cachePath,
      JSON.stringify({
        version: MODEL_INSIGHTS.cacheVersion - 1,
        fetchedAt: NOW.toISOString(),
        insights: { x: { id: "x" } },
      }),
      "utf8",
    );
    expect((await loadModelInsights({ now: NOW, cachePath, offline: true })).size).toBe(0);
  });

  it("never writes a cache it did not fetch", async () => {
    const cachePath = await tempCachePath();
    await loadModelInsights({ now: NOW, cachePath, offline: true });
    await expect(readFile(cachePath, "utf8")).rejects.toThrow();
  });
});
