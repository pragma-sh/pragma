import type { Api, Model } from "@earendil-works/pi-ai";
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { type ModelKind, PICK_MODEL, type PriceAnchor } from "./constants.ts";
import { isModelRecent, parseModelReleaseDate } from "./model-date.ts";
import {
  insightFor,
  insightKey,
  type ModelInsight,
  type ModelInsights,
  NO_INSIGHTS,
} from "./model-insights.ts";

/** Options shared by the selection entry points. */
export interface SelectModelOptions {
  /** modelgrep data from {@link loadModelInsights}. Defaults to none. */
  insights?: ModelInsights;
  /** Injected clock for the recency filter. */
  now?: Date;
}

/** A pool member paired with whatever modelgrep knows about it. */
interface Candidate {
  model: Model<Api>;
  insight: ModelInsight | undefined;
}

/** A blended price used to rank candidates; lower is cheaper. */
function costScore(model: Model<Api>): number {
  return model.cost.input + model.cost.output;
}

/**
 * Linear-interpolated quantile of `values` (which need not be sorted).
 * Returns `null` for an empty input.
 */
export function quantile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  if (lower === upper) return low;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

/**
 * Min-max normalize `value` into `0..1` against the pool's own range. A pool
 * with no spread normalizes to the neutral midpoint, so a constant metric
 * cannot decide the ranking.
 */
function normalize(value: number, min: number, max: number): number {
  if (!(max > min)) return 0.5;
  return (value - min) / (max - min);
}

/**
 * Group normalized scores into bands so recency can break "ties" between
 * continuous scores. Bands are grown from the leader down rather than cut on a
 * fixed grid: a fixed grid puts 0.999 and 1.0 on opposite sides of an edge,
 * which is exactly the near-tie the band exists to absorb.
 *
 * Returns each entry's band index — 0 is best, and equal indices are ties.
 */
function assignBands(scores: ReadonlyMap<string, number | null>): Map<string, number> {
  const ranked = [...scores.entries()]
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .toSorted((a, b) => b[1] - a[1]);

  const bands = new Map<string, number>();
  let index = -1;
  let leader = Number.POSITIVE_INFINITY;
  for (const [id, score] of ranked) {
    if (leader - score > PICK_MODEL.tieBand) {
      index += 1;
      leader = score;
    } else if (index < 0) {
      index = 0;
      leader = score;
    }
    bands.set(id, index);
  }

  // Models the metric cannot rank sort below every ranked one. The sentinel is
  // finite so that two unranked models still compare as equal (0), not NaN.
  for (const [id, score] of scores) {
    if (score === null) bands.set(id, Number.MAX_SAFE_INTEGER);
  }
  return bands;
}

/** Whether a model satisfies the non-reasoning preference for the fast tier. */
function matchesFastPreference(model: Model<Api>): boolean {
  return model.reasoning === PICK_MODEL.fast.reasoning;
}

/** Whether a model satisfies the non-negotiable requirements for the requested tier. */
function matchesKindBase(model: Model<Api>, kind: ModelKind): boolean {
  if (kind === "fast") {
    return model.contextWindow <= PICK_MODEL.fast.maxContextWindow;
  }
  const tier = PICK_MODEL[kind];
  return model.reasoning === tier.reasoning && model.contextWindow >= tier.minContextWindow;
}

/**
 * Resolve a tier's blended price ceiling from its anchor's live price, falling
 * back to the anchor's last-known price when modelgrep cannot be reached.
 *
 * Anchoring rather than hard-coding is the point: when Anthropic reprices Opus,
 * the "high" ceiling moves with it instead of silently capping at a number that
 * was true in 2026.
 */
export function priceCeiling(anchorName: PriceAnchor, insights: ModelInsights): number {
  const anchor = PICK_MODEL.priceAnchors[anchorName];
  for (const id of anchor.ids) {
    const insight = insights.get(insightKey(id));
    if (insight && insight.costInput !== null && insight.costOutput !== null) {
      return (insight.costInput + insight.costOutput) * PICK_MODEL.priceCeilingTolerance;
    }
  }
  return anchor.fallbackBlended * PICK_MODEL.priceCeilingTolerance;
}

/**
 * Drop everything above the tier's price ceiling.
 *
 * Unlike the percentile cuts this is **hard** — it is a budget, not a
 * statistical trim, so it is never relaxed to keep the pool non-empty. A user
 * whose only models cost more than Opus gets an explicit "no model available"
 * rather than a surprise bill.
 */
function applyPriceCeiling(
  candidates: readonly Candidate[],
  ceiling: number,
): readonly Candidate[] {
  return candidates.filter((candidate) => costScore(candidate.model) <= ceiling);
}

/** Values of one insight metric across the pool, skipping unmeasured models. */
function measured(
  candidates: readonly Candidate[],
  metric: (insight: ModelInsight) => number | null,
): number[] {
  return candidates.flatMap((candidate) => {
    const value = candidate.insight ? metric(candidate.insight) : null;
    return value === null ? [] : [value];
  });
}

/**
 * Apply a percentile cut, but never to the point of emptying the pool and never
 * on a pool too small for a percentile to mean anything. A cut that would
 * remove every candidate is discarded whole — a degraded ranking beats no
 * answer at all.
 */
function applyCut(
  candidates: readonly Candidate[],
  keep: (candidate: Candidate) => boolean,
): readonly Candidate[] {
  if (candidates.length < PICK_MODEL.minPoolForPercentileCuts) return candidates;
  const kept = candidates.filter(keep);
  return kept.length > 0 ? kept : candidates;
}

/**
 * Drop candidates below the pool's intelligence floor. Unbenchmarked models are
 * kept: modelgrep simply may not know them, and an unknown score is not a bad
 * one (same policy as {@link isModelRecent}).
 */
function applyIntelligenceFloor(candidates: readonly Candidate[]): readonly Candidate[] {
  const scores = measured(candidates, (insight) => insight.intelligence);
  if (scores.length < 2) return candidates;
  const floor = quantile(scores, PICK_MODEL.fast.minIntelligencePercentile);
  if (floor === null) return candidates;
  return applyCut(candidates, (candidate) => {
    const intelligence = candidate.insight?.intelligence ?? null;
    return intelligence === null || intelligence >= floor;
  });
}

/** A metric extracted from the pool, normalized so that higher is always better. */
interface PrimaryMetric {
  /** Higher is better; `null` marks a candidate the metric cannot rank. */
  score: (candidate: Candidate) => number | null;
  min: number;
  max: number;
}

function buildMetric(
  candidates: readonly Candidate[],
  raw: (candidate: Candidate) => number | null,
  higherIsBetter: boolean,
): PrimaryMetric | null {
  const values = candidates.flatMap((candidate) => {
    const value = raw(candidate);
    return value === null ? [] : [value];
  });
  if (values.length === 0) return null;
  const signed = (value: number) => (higherIsBetter ? value : -value);
  return {
    score: (candidate) => {
      const value = raw(candidate);
      return value === null ? null : signed(value);
    },
    min: Math.min(...values.map(signed)),
    max: Math.max(...values.map(signed)),
  };
}

/**
 * The metric the fast tier ranks on, in descending order of trust:
 * measured throughput, then measured time-to-first-token, then price as a proxy
 * for model size. modelgrep's speed feeds are frequently empty, so this ladder
 * is the normal path, not an edge case.
 */
function fastMetric(candidates: readonly Candidate[]): PrimaryMetric {
  return (
    buildMetric(candidates, (c) => c.insight?.throughputTps ?? null, true) ??
    buildMetric(candidates, (c) => c.insight?.latencyMs ?? null, false) ??
    // Cost is always present on a pi model, so this never returns null.
    (buildMetric(candidates, (c) => costScore(c.model), false) as PrimaryMetric)
  );
}

/**
 * The standard tier's balance: pool-normalized capability minus pool-normalized
 * price. Unbenchmarked models score the neutral midpoint for capability rather
 * than zero, so a model modelgrep has never heard of is judged on price alone
 * instead of being ranked last.
 */
function standardMetric(candidates: readonly Candidate[]): PrimaryMetric {
  const intelligences = measured(candidates, (insight) => insight.intelligence);
  const minIntelligence = intelligences.length > 0 ? Math.min(...intelligences) : 0;
  const maxIntelligence = intelligences.length > 0 ? Math.max(...intelligences) : 0;
  const costs = candidates.map((candidate) => costScore(candidate.model));
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const { weights } = PICK_MODEL.standard;

  const score = (candidate: Candidate): number => {
    const intelligence = candidate.insight?.intelligence ?? null;
    const capability =
      intelligence === null ? 0.5 : normalize(intelligence, minIntelligence, maxIntelligence);
    const price = normalize(costScore(candidate.model), minCost, maxCost);
    return weights.intelligence * capability - weights.cost * price;
  };

  const values = candidates.map(score);
  return { score, min: Math.min(...values), max: Math.max(...values) };
}

/**
 * The high tier ranks on raw capability — price is already bounded by the tier's
 * ceiling, so within that budget there is no reason to trade capability away.
 * Unbenchmarked models fall below every benchmarked one and are then ordered by
 * the shared chain, so an all-unknown pool resolves to the newest model.
 */
function highMetric(candidates: readonly Candidate[]): PrimaryMetric {
  return (
    buildMetric(candidates, (c) => c.insight?.intelligence ?? null, true) ?? {
      score: () => null,
      min: 0,
      max: 1,
    }
  );
}

/** The primary ranking metric for each tier. */
function metricFor(kind: ModelKind, candidates: readonly Candidate[]): PrimaryMetric {
  if (kind === "fast") return fastMetric(candidates);
  if (kind === "high") return highMetric(candidates);
  return standardMetric(candidates);
}

/**
 * Rank the pool: primary band descending, then the shared tiebreak chain —
 * newer, then cheaper, then larger context, then a stable id order. Candidates
 * the primary metric cannot rank sort below every ranked one, but stay ordered
 * among themselves by the same chain.
 */
function rank(candidates: readonly Candidate[], metric: PrimaryMetric): Model<Api>[] {
  const normalized = new Map<string, number | null>();
  for (const candidate of candidates) {
    const score = metric.score(candidate);
    normalized.set(
      candidate.model.id,
      score === null ? null : normalize(score, metric.min, metric.max),
    );
  }
  const bandOf = assignBands(normalized);

  return candidates
    .toSorted((a, b) => {
      const bandDiff = (bandOf.get(a.model.id) ?? 0) - (bandOf.get(b.model.id) ?? 0);
      if (bandDiff !== 0) return bandDiff;

      const dateDiff =
        (parseModelReleaseDate(b.model)?.getTime() ?? 0) -
        (parseModelReleaseDate(a.model)?.getTime() ?? 0);
      if (dateDiff !== 0) return dateDiff;

      const costDiff = costScore(a.model) - costScore(b.model);
      if (costDiff !== 0) return costDiff;

      const contextDiff = b.model.contextWindow - a.model.contextWindow;
      if (contextDiff !== 0) return contextDiff;

      return a.model.id.localeCompare(b.model.id);
    })
    .map((candidate) => candidate.model);
}

/**
 * Pure selection: from `models`, keep only recent ones that satisfy the
 * requested tier and its price ceiling, then return every candidate in
 * selection order.
 *
 * - `fast` prefers non-reasoning models, drops the pool's least capable, and
 *   ranks on measured throughput under the mid-tier ceiling.
 * - `standard` requires reasoning and ranks capability against price under the
 *   same mid-tier ceiling.
 * - `high` requires reasoning and ranks on raw capability under the frontier
 *   ceiling.
 *
 * All three fall back to price/recency when modelgrep knows nothing about the
 * user's models.
 */
export function selectModelCandidates(
  kind: ModelKind,
  models: readonly Model<Api>[],
  options: SelectModelOptions = {},
): Model<Api>[] {
  const insights = options.insights ?? NO_INSIGHTS;
  const eligible = models.filter(
    (model) =>
      matchesKindBase(model, kind) && isModelRecent(model, PICK_MODEL.maxAgeMonths, options.now),
  );

  const preferred =
    kind === "fast" && eligible.some(matchesFastPreference)
      ? eligible.filter(matchesFastPreference)
      : eligible;

  const affordable = applyPriceCeiling(
    preferred.map((model) => ({ model, insight: insightFor(insights, model) })),
    priceCeiling(PICK_MODEL[kind].priceAnchor, insights),
  );
  if (affordable.length === 0) return [];

  const pool = kind === "fast" ? applyIntelligenceFloor(affordable) : affordable;
  return rank(pool, metricFor(kind, pool));
}

/**
 * Pure selection: the best model of the requested tier, or `undefined` when
 * nothing qualifies. See {@link selectModelCandidates} for the ranking.
 */
export function selectModel(
  kind: ModelKind,
  models: readonly Model<Api>[],
  options: SelectModelOptions = {},
): Model<Api> | undefined {
  return selectModelCandidates(kind, models, options)[0];
}

/**
 * Pick the best model of the requested tier from the registry's available
 * (authenticated) models. Returns `undefined` when no model qualifies — e.g.
 * the user has not authenticated any provider that offers one.
 */
export function pickModel(
  kind: ModelKind,
  options: { authStorage: AuthStorage; registry: ModelRegistry } & SelectModelOptions,
): Model<Api> | undefined {
  return selectModel(kind, options.registry.getAvailable(), options);
}
