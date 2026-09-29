import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { HARNESS_INSIGHTS } from "./constants.ts";
import {
  loadHarnessInsights,
  modelSlugFromUrl,
  parseLeaderboardHtml,
  sliceJsonArray,
} from "./harness-insights.ts";

const NOW = new Date("2026-09-28T12:00:00Z");

const ROWS = [
  {
    id: "a",
    rank: 1,
    metadata: {
      date: "2026-09-03",
      agent_display: { url: "https://openai.com/codex/", label: "Codex" },
      model_display: {
        url: "https://developers.openai.com/api/docs/models/gpt-6-astra",
        label: "GPT-6 Astra",
      },
      reasoning_effort: "max",
    },
    metrics: {
      accuracy: 58.18,
      accuracy_ci95_half_width: 2.79,
      avg_trial_duration_sec: 2796.3,
      total_tokens: 1000,
      total_cost_usd: 50,
      successes: 10,
      n_trials: 330,
      // A string that contains brackets must not confuse the array slicer.
      display_accuracy: "**58.2%** [±2.8]",
    },
  },
  {
    id: "b",
    metadata: {
      agent_display: { url: "https://claude.com/product/claude-code", label: "Claude Code" },
      model_display: {
        url: "https://docs.anthropic.com/en/docs/about-claude/models/all-models",
        label: "Fable 5.1",
      },
    },
    metrics: { accuracy: 57.88, successes: 0, total_tokens: 5 },
  },
  { id: "broken", metadata: {}, metrics: { accuracy: 1 } },
];

/** Builds a page the way Next.js does: the payload split across escaped push() chunks. */
function leaderboardHtml(rows: unknown[]): string {
  const payload = `1d:["$","$L1e",null,{"state":{"queries":[{"state":{"data":{"leaderboard":{"title":"TB"},"rows":${JSON.stringify(rows)}}}}]}}]`;
  const middle = Math.floor(payload.length / 2);
  const chunks = [payload.slice(0, middle), payload.slice(middle)].map(
    (chunk) => `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`,
  );
  return `<html><body>${chunks.join("")}</body></html>`;
}

const failing = async () => {
  throw new Error("offline");
};
const notFound = async () => new Response("nope", { status: 503 });

async function tempCachePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "harness-insights-")), "cache.json");
}

describe("parseLeaderboardHtml", () => {
  it("extracts and derives every valid row across chunk boundaries", () => {
    const rows = parseLeaderboardHtml(leaderboardHtml(ROWS));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      agent: "Codex",
      model: "GPT-6 Astra",
      modelSlug: "gpt-6-astra",
      reasoningEffort: "max",
      accuracy: 58.18,
      accuracyCi95: 2.79,
      avgTaskSeconds: 2796.3,
      tokensPerSolve: 100,
      costPerSolveUsd: 5,
      trials: 330,
      date: "2026-09-03",
    });
    expect(rows[1]).toMatchObject({
      agent: "Claude Code",
      modelSlug: null,
      reasoningEffort: null,
      tokensPerSolve: null,
    });
  });

  it("returns nothing for a page without rows", () => {
    expect(parseLeaderboardHtml("<html></html>")).toEqual([]);
    expect(parseLeaderboardHtml(leaderboardHtml([]))).toEqual([]);
  });
});

describe("modelSlugFromUrl", () => {
  it("only accepts a versioned final segment", () => {
    expect(modelSlugFromUrl({ url: "https://x.test/models/gpt-6-astra/" })).toBe("gpt-6-astra");
    expect(modelSlugFromUrl({ url: "https://x.test/models/all-models" })).toBeNull();
    expect(modelSlugFromUrl({ url: "not a url" })).toBeNull();
  });
});

describe("sliceJsonArray", () => {
  it("respects nested structures and quoted brackets", () => {
    const text = 'x:[1,{"a":"]"},[2]] tail';
    expect(sliceJsonArray(text, 2)).toBe('[1,{"a":"]"},[2]]');
    expect(sliceJsonArray("[1,", 0)).toBeNull();
  });
});

describe("loadHarnessInsights", () => {
  it("fetches, caches, and then serves the cache offline", async () => {
    const cachePath = await tempCachePath();
    const fetchMock = vi.fn(async () => new Response(leaderboardHtml(ROWS)));
    const fetched = await loadHarnessInsights({
      now: NOW,
      cachePath,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(fetched).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(HARNESS_INSIGHTS.leaderboardUrl, expect.anything());

    const cached = await loadHarnessInsights({ now: NOW, cachePath, offline: true });
    expect(cached).toEqual(fetched);
  });

  it("never throws and never caches a failure", async () => {
    const cachePath = await tempCachePath();
    await expect(
      loadHarnessInsights({ now: NOW, cachePath, fetch: failing as unknown as typeof fetch }),
    ).resolves.toEqual([]);
    await expect(
      loadHarnessInsights({ now: NOW, cachePath, fetch: notFound as unknown as typeof fetch }),
    ).resolves.toEqual([]);
    await expect(readFile(cachePath, "utf8")).rejects.toThrow();
  });

  it("ignores a stale cache", async () => {
    const cachePath = await tempCachePath();
    await writeFile(
      cachePath,
      JSON.stringify({
        version: HARNESS_INSIGHTS.cacheVersion,
        fetchedAt: "2026-09-01T00:00:00Z",
        rows: [{ agent: "Codex", model: "m", accuracy: 1 }],
      }),
    );
    await expect(loadHarnessInsights({ now: NOW, cachePath, offline: true })).resolves.toEqual([]);
  });
});
