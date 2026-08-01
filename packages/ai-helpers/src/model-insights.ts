/**
 * Model metadata that pi's registry does not carry — serving throughput,
 * time-to-first-token, and independent benchmark scores — sourced from the
 * [modelgrep](https://modelgrep.com/api) free JSON API.
 *
 * pi's `Model` knows price, context window, and whether a model reasons. It
 * knows nothing about how fast the model serves tokens or how capable it is,
 * which is exactly what {@link selectModel} needs to stop guessing. This module
 * fetches that, caches it on disk, and matches it back onto pi models by id.
 *
 * **Every field here is optional by design.** modelgrep aggregates OpenRouter
 * (speed/price) and Artificial Analysis (benchmarks); either feed can be empty
 * for a given model — as of this writing `throughput_tps` is `null` for the
 * whole catalog — and the user may be offline. Selection therefore treats
 * insights as a bonus signal layered over the price/recency heuristics, never
 * as a requirement.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { MODEL_INSIGHTS } from "./constants.ts";

/** The subset of modelgrep's model record Pragma ranks on. */
export interface ModelInsight {
  /** modelgrep's canonical `maker/model` id, kept for diagnostics. */
  id: string;
  /** p50 output tokens per second, or `null` when modelgrep has no sample. */
  throughputTps: number | null;
  /** p50 time-to-first-token in milliseconds, or `null` when unsampled. */
  latencyMs: number | null;
  /** Artificial Analysis intelligence index (higher is more capable). */
  intelligence: number | null;
  /** Artificial Analysis coding score. */
  coding: number | null;
  /** Input price, USD per million tokens. */
  costInput: number | null;
  /** Output price, USD per million tokens. */
  costOutput: number | null;
}

/** A resolved lookup from a pi model id to its modelgrep insight. */
export type ModelInsights = ReadonlyMap<string, ModelInsight>;

/** An empty lookup — the offline/unavailable case. */
export const NO_INSIGHTS: ModelInsights = new Map();

interface CacheFile {
  version: number;
  fetchedAt: string;
  insights: Record<string, ModelInsight>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reduce a model id from either side to a comparable key.
 *
 * pi ids and modelgrep ids describe the same models in different dialects —
 * `claude-sonnet-4-5-20250929` (pi) vs `anthropic/claude-sonnet-4.5:batch`
 * (modelgrep). Dropping the maker prefix, the variant suffix, the release date,
 * and every separator collapses both to `claudesonnet45`.
 */
export function insightKey(rawId: string): string {
  return rawId
    .toLowerCase()
    .replace(/^[^/]+\//, "")
    .replace(/:.*$/, "")
    .replace(/[-_]?(20\d{2})-?(0[1-9]|1[0-2])-?(0[1-9]|[12]\d|3[01])$/, "")
    .replace(/[-_]?latest$/, "")
    .replace(/[.\-_\s]/g, "");
}

function parseInsight(entry: unknown): ModelInsight | null {
  if (!isRecord(entry) || typeof entry.id !== "string") return null;

  const performance = isRecord(entry.performance) ? entry.performance : {};
  const pricing = isRecord(entry.pricing) ? entry.pricing : {};
  const benchmarks = isRecord(entry.benchmarks) ? entry.benchmarks : {};
  const analysis = isRecord(benchmarks.artificial_analysis) ? benchmarks.artificial_analysis : {};

  return {
    id: entry.id,
    throughputTps: numberOrNull(performance.throughput_tps),
    latencyMs: numberOrNull(performance.latency_ms),
    intelligence: numberOrNull(analysis.intelligence),
    coding: numberOrNull(analysis.coding),
    costInput: numberOrNull(pricing.input),
    costOutput: numberOrNull(pricing.output),
  };
}

/** How much usable signal an insight carries, used to break id collisions. */
function insightWeight(insight: ModelInsight): number {
  return (
    (insight.throughputTps === null ? 0 : 2) +
    (insight.latencyMs === null ? 0 : 1) +
    (insight.intelligence === null ? 0 : 1) +
    (insight.costInput === null ? 0 : 1)
  );
}

/**
 * Index modelgrep records by {@link insightKey}. Several catalog entries can
 * collapse to one key (a model, its `:free` mirror, its `:batch` mirror); the
 * entry carrying the most signal wins, so a benchmarked base model is never
 * shadowed by an empty variant.
 */
export function indexInsights(entries: readonly unknown[]): Map<string, ModelInsight> {
  const index = new Map<string, ModelInsight>();
  for (const entry of entries) {
    const insight = parseInsight(entry);
    if (!insight) continue;
    const key = insightKey(insight.id);
    const existing = index.get(key);
    if (!existing || insightWeight(insight) > insightWeight(existing)) {
      index.set(key, insight);
    }
  }
  return index;
}

/** Absolute path of the on-disk insight cache. */
export function insightCachePath(): string {
  return join(homedir(), MODEL_INSIGHTS.cacheFile);
}

/** Read and JSON-parse the cache file, or `null` if it is missing or corrupt. */
async function readCacheJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Validate a parsed cache file's envelope: correct shape, matching schema
 * version, and within the TTL. A future `fetchedAt` (a clock that moved
 * backwards) is treated as expired rather than trusted forever.
 */
function isUsableCacheFile(parsed: unknown, now: Date): parsed is CacheFile {
  if (!isRecord(parsed) || typeof parsed.fetchedAt !== "string" || !isRecord(parsed.insights)) {
    return false;
  }
  if (parsed.version !== MODEL_INSIGHTS.cacheVersion) return false;

  const fetchedAt = new Date(parsed.fetchedAt).getTime();
  if (Number.isNaN(fetchedAt)) return false;
  const ageHours = (now.getTime() - fetchedAt) / 3_600_000;
  return ageHours >= 0 && ageHours <= MODEL_INSIGHTS.cacheTtlHours;
}

async function readCache(path: string, now: Date): Promise<Map<string, ModelInsight> | null> {
  const parsed = await readCacheJson(path);
  if (!isUsableCacheFile(parsed, now)) return null;

  const index = new Map<string, ModelInsight>();
  for (const [key, value] of Object.entries(parsed.insights)) {
    const insight = parseInsightFromCache(value);
    if (insight) index.set(key, insight);
  }
  return index;
}

function parseInsightFromCache(value: unknown): ModelInsight | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    throughputTps: numberOrNull(value.throughputTps),
    latencyMs: numberOrNull(value.latencyMs),
    intelligence: numberOrNull(value.intelligence),
    coding: numberOrNull(value.coding),
    costInput: numberOrNull(value.costInput),
    costOutput: numberOrNull(value.costOutput),
  };
}

async function writeCache(
  path: string,
  index: ReadonlyMap<string, ModelInsight>,
  now: Date,
): Promise<void> {
  const file: CacheFile = {
    version: MODEL_INSIGHTS.cacheVersion,
    fetchedAt: now.toISOString(),
    insights: Object.fromEntries(index),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

async function fetchPage(offset: number, signal: AbortSignal): Promise<unknown[]> {
  const url = new URL(`${MODEL_INSIGHTS.baseUrl}/models`);
  url.searchParams.set("limit", String(MODEL_INSIGHTS.pageSize));
  url.searchParams.set("offset", String(offset));

  const response = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`modelgrep responded ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("modelgrep returned an unexpected payload");
  }
  return body.data;
}

/** Fetch the whole modelgrep catalog, paging until it is exhausted. */
async function fetchCatalog(signal: AbortSignal): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (let page = 0; page < MODEL_INSIGHTS.maxPages; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- offsets are sequential; the next page depends on this one being short or not.
    const data = await fetchPage(page * MODEL_INSIGHTS.pageSize, signal);
    entries.push(...data);
    if (data.length < MODEL_INSIGHTS.pageSize) break;
  }
  return entries;
}

/**
 * Load model insights, preferring a fresh on-disk cache and falling back to a
 * network fetch. **Never throws and never blocks selection for long**: a
 * failure (offline, timeout, bad payload) resolves to an empty lookup, which
 * degrades selection to the price/recency heuristics.
 */
export async function loadModelInsights(options?: {
  now?: Date;
  cachePath?: string;
  /** Skip the network entirely — used by tests and by any offline caller. */
  offline?: boolean;
}): Promise<ModelInsights> {
  const now = options?.now ?? new Date();
  const path = options?.cachePath ?? insightCachePath();

  const cached = await readCache(path, now);
  if (cached) return cached;
  if (options?.offline) return NO_INSIGHTS;

  try {
    const entries = await fetchCatalog(AbortSignal.timeout(MODEL_INSIGHTS.fetchTimeoutMs));
    const index = indexInsights(entries);
    if (index.size === 0) return NO_INSIGHTS;
    await writeCache(path, index, now).catch(() => {
      // A read-only home directory must not fail model selection.
    });
    return index;
  } catch {
    return NO_INSIGHTS;
  }
}

/** Look up the insight for a pi model, or `undefined` when unmatched. */
export function insightFor(
  insights: ModelInsights,
  model: { id: string },
): ModelInsight | undefined {
  return insights.get(insightKey(model.id));
}
