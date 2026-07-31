/**
 * Requirements that drive {@link selectModel}/`pickModel`.
 *
 * These are TypeScript-only because model selection runs entirely inside the
 * pi (JS) sidecar — they never cross the TS/Rust boundary, so they live here
 * rather than in `@pragma/constants`.
 *
 * **Rankings are relative, never absolute.** Every percentile cut below is
 * taken over the user's own authenticated pool, so a user with one Anthropic
 * key and a user with the whole OpenRouter catalog both get a sane pick, and no
 * ranking number here rots when the next model generation ships.
 *
 * **Price ceilings are the one absolute, and they are anchored, not typed in.**
 * Each tier caps blended spend at the live price of a named reference model
 * (see {@link PICK_MODEL.priceAnchors}), so the ceiling tracks the market
 * instead of freezing a number that was true once.
 */
export const PICK_MODEL = {
  /**
   * A model whose id/name encodes a release date older than this many months is
   * excluded. Models without a parseable date are kept (age unknown).
   */
  maxAgeMonths: 3,
  /**
   * Ranking scores are min-max normalized to `0..1` within the pool, then
   * grouped into bands this wide. Models landing in the same band are treated
   * as tied and broken by recency, so a 1%-better score never beats a model
   * three months newer.
   */
  tieBand: 0.05,
  /**
   * A pool smaller than this makes percentile cuts meaningless (a decile of
   * three models is noise), so they are skipped below it. Keep it low: a user
   * signed in to Anthropic and OpenAI has ~5 eligible models after the recency
   * filter, and a higher floor would quietly turn every cut into a no-op for
   * the common case.
   */
  minPoolForPercentileCuts: 4,
  /**
   * Blended (`input + output`, USD per million tokens) price ceilings, each
   * anchored to a reference model rather than hard-coded. Ids are tried in
   * order and the first one modelgrep knows sets the ceiling, so the cap
   * follows the anchor's real price; `fallbackBlended` applies only when
   * modelgrep is unreachable and none of the ids resolve.
   */
  priceAnchors: {
    /** Mid-tier reference — the most a routine helper may cost. */
    sonnet: {
      ids: ["anthropic/claude-sonnet-5", "anthropic/claude-sonnet-4.5"],
      fallbackBlended: 18,
    },
    /** Frontier reference — the hard ceiling for the heaviest work. */
    opus: {
      ids: ["anthropic/claude-opus-5", "anthropic/claude-opus-4.5"],
      fallbackBlended: 30,
    },
  },
  /**
   * "Roughly the anchor's price": 10% headroom, so a model a shade over the
   * reference is not cut on a rounding difference.
   */
  priceCeilingTolerance: 1.1,
  /** "Fast" models: highest throughput, non-reasoning — for low-latency UI helpers. */
  fast: {
    reasoning: false,
    /** A larger context window than this is overkill for a quick helper. */
    maxContextWindow: 500_000,
    /**
     * Drop models below this intelligence percentile of the pool. Stops "fastest"
     * from resolving to a tiny model that cannot write a commit message.
     */
    minIntelligencePercentile: 0.4,
    /** Speed is the point; there is never a reason to pay above mid-tier for it. */
    priceAnchor: "sonnet",
  },
  /** "Standard" models: reasoning, balanced capability against cost. */
  standard: {
    reasoning: true,
    /**
     * Covers the largest prompt we send (`PULL_REQUEST_DIFF_CHAR_LIMIT`, 80k
     * chars ≈ 25k tokens) plus AGENTS.md, skills, and a tool-using agent loop
     * with generous headroom.
     */
    minContextWindow: 128_000,
    /** The mid-tier cap is what makes this tier "balanced" rather than frontier. */
    priceAnchor: "sonnet",
    /**
     * Weights over pool-normalized capability and cost. Capability outweighs
     * price, but not by enough to buy a marginal gain at any price.
     */
    weights: { intelligence: 0.6, cost: 0.4 },
  },
  /** "High" models: the most capable model that still fits the frontier ceiling. */
  high: {
    reasoning: true,
    minContextWindow: 128_000,
    priceAnchor: "opus",
  },
} as const;

/** modelgrep API + on-disk cache settings for {@link loadModelInsights}. */
export const MODEL_INSIGHTS = {
  baseUrl: "https://modelgrep.com/api/v1",
  /** Cache location, relative to the user's home directory. */
  cacheFile: ".pragma/cache/model-insights.json",
  /**
   * Bump whenever {@link ModelInsight} gains a field. A cache written by an
   * older build parses fine but silently carries `null` for the new field —
   * which, for a field a price ceiling is anchored to, means falling back to a
   * stale ceiling for up to a day with no visible error.
   */
  cacheVersion: 2,
  /** modelgrep refreshes speed hourly and benchmarks daily; a day is plenty. */
  cacheTtlHours: 24,
  /** Model selection must never hang on the network. */
  fetchTimeoutMs: 2_000,
  /** modelgrep's documented per-request maximum. */
  pageSize: 200,
  /** Bounds the paging loop; the catalog is ~350 models. */
  maxPages: 10,
} as const;

/** The model tiers a Pragma AI feature can request. */
export type ModelKind = "fast" | "standard" | "high";

/** Reference models the tier price ceilings are anchored to. */
export type PriceAnchor = keyof typeof PICK_MODEL.priceAnchors;
