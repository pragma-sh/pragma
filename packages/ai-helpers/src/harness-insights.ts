/**
 * Harness benchmark results — how well a coding-agent **harness** (Claude
 * Code, Codex, …) does with a given model — from the Terminal-Bench
 * leaderboard.
 *
 * Model benchmarks (`model-insights.ts`) score a model in isolation. The same
 * model scores differently under different harnesses, and the harness also
 * decides how long a task takes and how many tokens it burns. Terminal-Bench
 * reports exactly those axes per agent × model × reasoning effort:
 *
 * | Axis             | Derived from                                 |
 * | ---------------- | -------------------------------------------- |
 * | accuracy         | `metrics.accuracy` (%, with a 95% CI)        |
 * | speed            | `metrics.avg_trial_duration_sec`             |
 * | token efficiency | `metrics.total_tokens / metrics.successes`   |
 * | cost efficiency  | `metrics.total_cost_usd / metrics.successes` |
 *
 * **The source is a web page, not an API.** The leaderboard embeds its rows
 * (validated server-side against a published schema) in the React Server
 * Components payload. {@link parseLeaderboardHtml} decodes those chunks and
 * extracts the `rows` array; every field is re-validated here. If the page
 * changes shape the parse yields nothing and auto mode proceeds on model
 * benchmarks alone — this module never throws to its caller.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { HARNESS_INSIGHTS } from "./constants.ts";
import { type DiskCacheSpec, readDiskCache, writeDiskCache } from "./disk-cache.ts";

/** One leaderboard row: a harness running a model at a reasoning effort. */
export interface HarnessInsight {
  /** Harness display name, e.g. `Claude Code`. */
  agent: string;
  /** Model display name, e.g. `GPT-6 Astra`. */
  model: string;
  /** Last path segment of the model's docs URL when it names the model (e.g. `gpt-6-astra`). */
  modelSlug: string | null;
  /** Reasoning effort the run used, e.g. `max`, or `null` when unreported. */
  reasoningEffort: string | null;
  /** Pass rate, 0–100. */
  accuracy: number;
  /** Half-width of the 95% confidence interval on `accuracy`, in points. */
  accuracyCi95: number | null;
  /** Mean wall time per task, seconds. */
  avgTaskSeconds: number | null;
  /** Total tokens spent per solved task. */
  tokensPerSolve: number | null;
  /** USD spent per solved task. */
  costPerSolveUsd: number | null;
  /** Number of trials the row aggregates. */
  trials: number | null;
  /** Submission date, `YYYY-MM-DD`. */
  date: string | null;
}

/** Every leaderboard row, or an empty list when unavailable. */
export type HarnessInsights = readonly HarnessInsight[];

/** The offline/unavailable case. */
export const NO_HARNESS_INSIGHTS: HarnessInsights = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function label(value: unknown): string | null {
  if (!isRecord(value) || typeof value.label !== "string") return null;
  const text = value.label.trim();
  return text || null;
}

/**
 * The model slug from a docs URL like `…/models/gpt-6-astra`. Generic catalog
 * pages (`…/all-models`, `…/overview`) name no model, so only a final segment
 * that contains a digit counts — every real model id has a version in it.
 */
export function modelSlugFromUrl(url: unknown): string | null {
  if (!isRecord(url) || typeof url.url !== "string") return null;
  try {
    const segments = new URL(url.url).pathname.split("/").filter(Boolean);
    const last = segments.at(-1)?.toLowerCase() ?? "";
    return /\d/.test(last) ? last : null;
  } catch {
    return null;
  }
}

function perSolve(total: number | null, successes: number | null): number | null {
  if (total === null || successes === null || successes <= 0) return null;
  return total / successes;
}

/** Validates one raw leaderboard row. */
function parseLeaderboardRow(row: unknown): HarnessInsight | null {
  if (!isRecord(row) || !isRecord(row.metadata) || !isRecord(row.metrics)) return null;
  const identity = rowIdentity(row.metadata);
  const metrics = rowMetrics(row.metrics);
  return identity && metrics ? { ...identity, ...metrics } : null;
}

/** Who ran what: the harness, the model, and the effort. */
function rowIdentity(
  metadata: Record<string, unknown>,
): Pick<HarnessInsight, "agent" | "model" | "modelSlug" | "reasoningEffort" | "date"> | null {
  const agent = label(metadata.agent_display);
  const model = label(metadata.model_display);
  if (!agent || !model) return null;
  return {
    agent,
    model,
    modelSlug: modelSlugFromUrl(metadata.model_display),
    reasoningEffort: stringOrNull(metadata.reasoning_effort) || null,
    date: stringOrNull(metadata.date),
  };
}

/** How it went: accuracy, plus the per-task and per-solve costs derived from the totals. */
function rowMetrics(
  metrics: Record<string, unknown>,
): Omit<HarnessInsight, "agent" | "model" | "modelSlug" | "reasoningEffort" | "date"> | null {
  const accuracy = finite(metrics.accuracy);
  if (accuracy === null) return null;
  const successes = finite(metrics.successes);
  return {
    accuracy,
    accuracyCi95: finite(metrics.accuracy_ci95_half_width),
    avgTaskSeconds: finite(metrics.avg_trial_duration_sec),
    tokensPerSolve: perSolve(finite(metrics.total_tokens), successes),
    costPerSolveUsd: perSolve(finite(metrics.total_cost_usd), successes),
    trials: finite(metrics.n_trials),
  };
}

const FLIGHT_CHUNK = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

/** Decodes and concatenates the page's RSC flight chunks (each a JS string literal). */
function decodeFlightPayload(html: string): string {
  let payload = "";
  for (const match of html.matchAll(FLIGHT_CHUNK)) {
    try {
      payload += JSON.parse(`"${match[1] ?? ""}"`) as string;
    } catch {
      // A chunk using a JS-only escape is not one of the data chunks we need.
    }
  }
  return payload;
}

/** Returns the JSON array that opens at `start` (a `[`), respecting strings. */
export function sliceJsonArray(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Extracts every valid row from the leaderboard page. Returns an empty list
 * when the page no longer carries a `rows` array in the shape expected.
 */
export function parseLeaderboardHtml(html: string): HarnessInsight[] {
  const payload = decodeFlightPayload(html);
  const marker = payload.indexOf('"rows":[');
  if (marker < 0) return [];
  const array = sliceJsonArray(payload, marker + '"rows":'.length);
  if (!array) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(array);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.map(parseLeaderboardRow).filter((row): row is HarnessInsight => row !== null);
}

/** Absolute path of the on-disk harness cache. */
export function harnessCachePath(): string {
  return join(homedir(), HARNESS_INSIGHTS.cacheFile);
}

function cacheSpec(path: string): DiskCacheSpec {
  return {
    path,
    version: HARNESS_INSIGHTS.cacheVersion,
    ttlHours: HARNESS_INSIGHTS.cacheTtlHours,
    payloadKey: "rows",
  };
}

function stringOrNull(field: unknown): string | null {
  return typeof field === "string" ? field : null;
}

/** Rows round-trip through the cache in their parsed shape; re-validate each. */
function parseCachedRow(value: unknown): HarnessInsight | null {
  if (!isRecord(value)) return null;
  if (typeof value.agent !== "string" || typeof value.model !== "string") return null;
  const accuracy = finite(value.accuracy);
  if (accuracy === null) return null;
  return {
    agent: value.agent,
    model: value.model,
    modelSlug: stringOrNull(value.modelSlug),
    reasoningEffort: stringOrNull(value.reasoningEffort),
    accuracy,
    accuracyCi95: finite(value.accuracyCi95),
    avgTaskSeconds: finite(value.avgTaskSeconds),
    tokensPerSolve: finite(value.tokensPerSolve),
    costPerSolveUsd: finite(value.costPerSolveUsd),
    trials: finite(value.trials),
    date: stringOrNull(value.date),
  };
}

async function readCache(path: string, now: Date): Promise<HarnessInsight[] | null> {
  const rows = await readDiskCache(cacheSpec(path), now);
  if (!Array.isArray(rows)) return null;
  return rows.map(parseCachedRow).filter((row): row is HarnessInsight => row !== null);
}

/**
 * Loads harness insights, preferring a fresh on-disk cache. **Never throws**:
 * offline, a timeout, or a changed page all resolve to an empty list.
 */
export async function loadHarnessInsights(options?: {
  now?: Date;
  cachePath?: string;
  offline?: boolean;
  /** Injected for tests; defaults to the platform `fetch`. */
  fetch?: typeof fetch;
}): Promise<HarnessInsights> {
  const now = options?.now ?? new Date();
  const path = options?.cachePath ?? harnessCachePath();

  const cached = await readCache(path, now);
  if (cached) return cached;
  if (options?.offline) return NO_HARNESS_INSIGHTS;

  try {
    const response = await (options?.fetch ?? fetch)(HARNESS_INSIGHTS.leaderboardUrl, {
      signal: AbortSignal.timeout(HARNESS_INSIGHTS.fetchTimeoutMs),
      headers: { accept: "text/html" },
    });
    if (!response.ok) return NO_HARNESS_INSIGHTS;
    const rows = parseLeaderboardHtml(await response.text());
    if (rows.length === 0) return NO_HARNESS_INSIGHTS;
    await writeDiskCache(cacheSpec(path), rows, now);
    return rows;
  } catch {
    return NO_HARNESS_INSIGHTS;
  }
}
