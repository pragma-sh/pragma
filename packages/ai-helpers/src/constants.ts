/**
 * Requirements that drive {@link selectModel}/`pickModel`.
 *
 * These are TypeScript-only because model selection runs entirely inside the
 * pi (JS) sidecar — they never cross the TS/Rust boundary, so they live here
 * rather than in `@pragma/constants`.
 */
export const PICK_MODEL = {
  /**
   * A model whose id/name encodes a release date older than this many months is
   * excluded. Models without a parseable date are kept (age unknown).
   */
  maxAgeMonths: 3,
  /** "Quick" models: fast, cheap, prefer non-reasoning — for low-latency UI helpers. */
  quick: {
    reasoning: false,
    /** A larger context window than this is overkill for a quick helper. */
    maxContextWindow: 500_000,
  },
  /** "Standard" models: reasoning-capable with a large context window. */
  standard: {
    reasoning: true,
    /** Standard models must exceed this context window. */
    minContextWindow: 256_000,
  },
} as const;

/** The two model tiers a Pragma AI feature can request. */
export type ModelKind = "quick" | "standard";
