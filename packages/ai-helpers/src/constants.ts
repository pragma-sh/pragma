/**
 * Requirements that drive {@link selectModel}/`pickModel`.
 *
 * These are TypeScript-only because model selection runs entirely inside the
 * pi (JS) sidecar — they never cross the TS/Rust boundary, so they live here
 * rather than in `@pragma-sh/constants`.
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

/** Bounds on the shared model-fallback loop in `runPromptWithFallback`. */
export const RUN_FALLBACK = {
  /**
   * Hard cap on candidate models tried for one request. A tier can offer twenty
   * candidates, and when the real problem is a rejected key or an exhausted
   * subscription every one of them fails — serially, at a round-trip each. Three
   * attempts is enough to route around a single bad model while keeping the
   * worst case short enough for an interactive helper to report an error in.
   */
  maxAttempts: 3,
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

/**
 * Terminal-Bench leaderboard + on-disk cache settings for
 * {@link loadHarnessInsights}. Harness-level results — one row per agent ×
 * model × reasoning effort — are what tell auto mode that the same model
 * scores differently under Claude Code and Codex.
 */
export const HARNESS_INSIGHTS = {
  /**
   * The official leaderboard page. There is no documented JSON endpoint; the
   * page embeds its rows (validated against a published schema) in the React
   * Server Components payload, which `parseLeaderboardHtml` extracts.
   */
  leaderboardUrl: "https://www.tbench.ai/leaderboard/terminal-bench",
  /** Human label for the source, shown alongside the numbers. */
  sourceLabel: "Terminal-Bench",
  cacheFile: ".pragma/cache/harness-insights.json",
  /** Bump whenever {@link HarnessInsight} gains a field. */
  cacheVersion: 1,
  /** The leaderboard changes a few times a month; a day is plenty. */
  cacheTtlHours: 24,
  /** A launch must never hang on a third-party page. */
  fetchTimeoutMs: 3_000,
} as const;

/** Knobs for the System 1 auto-select request (see `auto-select.ts`). */
export const AUTO_SELECT = {
  /**
   * Most models offered to the System 1 model per agent. OpenCode can list
   * hundreds; the API caps a choice at 255 options and a long tail of
   * unbenchmarked models only dilutes the probabilities. Models with benchmark
   * data are kept first.
   */
  maxModelsPerAgent: 40,
  /** Harness results shown per agent, best accuracy first. */
  maxHarnessRowsPerAgent: 6,
  /** Below this agent-choice confidence the UI flags the pick as a guess. */
  lowConfidence: 0.35,
} as const;

/** Knobs for AI merge-conflict resolution (see `merge-conflicts.ts`). */
export const MERGE_CONFLICTS = {
  /**
   * A conflict's combined score is `confidence × (1 − riskWeight × risk)`,
   * with `risk` normalized to `0..1`. Risk only nudges the bar: a critical
   * conflict needs ~1.3× the confidence of a trivial one, not twice as much.
   */
  riskWeight: 0.25,
  /**
   * Below this combined score on **any** conflict, the whole file goes to the
   * built-in AI for verification. Deliberately permissive: with four real
   * options 0.25 is chance, and System 1 escalates on its own by answering
   * `combine` when no pick is correct. So this bar only has to catch a
   * genuine coin-flip, not every less-than-certain answer.
   */
  minCombinedScore: 0.35,
  /**
   * A `combine` answer (System 1 says the sides need a hand merge) escalates
   * only at or above this normalized risk — 0.25 is the "Low" level. On a
   * trivial conflict (wording, formatting, comments) a hand merge is not worth
   * an LLM call, so System 1's best real option is taken instead.
   */
  combineMinRisk: 0.25,
  /**
   * Per-file System 1 request timeout. Longer than auto mode's, because a
   * conflicted file is a much larger state than a launch prompt.
   */
  system1TimeoutMs: 30_000,
  /** Lines of unconflicted code shown around each conflict, per side. */
  contextLines: 12,
  /**
   * Most characters of one conflict side sent to System 1. A side cut here is
   * a conflict System 1 did not fully see, so its file is always verified.
   */
  maxSideChars: 6_000,
  /** Commit messages per branch per file, newest first. */
  maxCommitsPerSide: 20,
  /** Pull request description characters included as intent. */
  maxDescriptionChars: 4_000,
  /** Conflicted-file characters included in the verification prompt. */
  maxVerifyFileChars: 60_000,
} as const;
