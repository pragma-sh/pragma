import type { UsageLimit, UsageLimitsProvider, UsageLimitsResult } from "./generated/constants";

/** How close to its limit a category is, for clients to map onto their own styling. */
export type UsageSeverity = "ok" | "warning" | "critical";

/**
 * Bounded percentage used, or null when the category is unlimited. Null is not
 * zero: a client must render "Unlimited", never an empty bar implying no usage.
 */
export function percentUsed(limit: UsageLimit): number | null {
  if (limit.limit === null || limit.limit === undefined || limit.limit <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, (limit.used / limit.limit) * 100));
}

/** The collapsed-row label for one category. */
export function usagePercentLabel(limit: UsageLimit): string {
  const percent = percentUsed(limit);
  return percent === null ? "Unlimited" : `${Math.round(percent)}% used`;
}

/** Maps a percentage onto usage severity. */
export function usageSeverity(percent: number): UsageSeverity {
  if (percent < 50) return "ok";
  if (percent < 75) return "warning";
  return "critical";
}

/**
 * The category shown on a provider's collapsed row: the provider's own summary
 * when it supplies one, otherwise the category it named as primary. Undefined
 * for a reading that is not ready — which a client must render as its own
 * state, not as a zero-usage bar.
 */
export function resolvePrimaryLimit(
  primaryLimitId: string,
  result: UsageLimitsResult | undefined,
): UsageLimit | undefined {
  if (result?.status !== "ready") {
    return undefined;
  }
  return result.summary ?? result.limits.find((limit) => limit.id === primaryLimitId);
}

/** When a category resets, as milliseconds from now. */
export function resetsInMs(
  limit: UsageLimit,
  observedAt: number,
  now: number = Date.now(),
): number | null {
  return limit.resetsInMs === undefined ? null : observedAt + limit.resetsInMs - now;
}

/** Formats a reset countdown without rounding a partial day up to the next one. */
export function formatDuration(durationMs: number): string {
  const minutes = Math.max(0, Math.ceil(durationMs / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.ceil(durationMs / (60 * 60_000));
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(minutes / (60 * 24))}d`;
}

/** Whether a cached reading is old enough that a client should label it stale. */
export function isStaleReading(
  provider: Pick<UsageLimitsProvider, "observedAt">,
  staleAfterMs: number,
  now: number = Date.now(),
): boolean {
  return provider.observedAt !== undefined && now - provider.observedAt > staleAfterMs;
}
