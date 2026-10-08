import type { UsageLimit, UsageLimitsResult } from "@pragma-sh/constants";

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

/**
 * Validates a provider's usage result. Anything malformed becomes an
 * `unavailable` error result rather than a crash in the menu.
 */
export function validateUsageLimitsResult(
  title: string,
  primaryLimitId: string | null,
  value: unknown,
): UsageLimitsResult {
  const result = value as UsageLimitsResult | undefined;
  if (!result || typeof result !== "object") {
    return invalid(`${title} returned no usage data`);
  }
  if (result.status === "unavailable") {
    return typeof result.message === "string" ? result : invalid(`${title} returned no message`);
  }
  if (result.status !== "ready" || !Number.isFinite(result.observedAt)) {
    return invalid(`${title} returned an invalid observation time`);
  }
  if (!Array.isArray(result.limits) || !uniqueValidLimits(result.limits)) {
    return invalid(`${title} returned an invalid usage limit`);
  }
  if (result.summary !== undefined && !isValidUsageLimit(result.summary)) {
    return invalid(`${title} returned an invalid summary limit`);
  }
  if (primaryLimitId && !primaryLimit(result, primaryLimitId)) {
    return invalid(`${title} did not return primary limit "${primaryLimitId}"`);
  }
  return result;
}

/** The limit shown on an account's collapsed row, if any. */
export function primaryLimit(
  result: UsageLimitsResult | undefined,
  primaryLimitId: string | null,
): UsageLimit | undefined {
  if (result?.status !== "ready") {
    return undefined;
  }
  return (
    result.summary ??
    result.limits.find((limit) => limit.id === primaryLimitId) ??
    (primaryLimitId ? undefined : result.limits[0])
  );
}

function invalid(message: string): UsageLimitsResult {
  return { status: "unavailable", reason: "error", message };
}

function uniqueValidLimits(limits: readonly UsageLimit[]): boolean {
  const ids = new Set<string>();
  for (const limit of limits) {
    if (ids.has(limit.id) || !isValidUsageLimit(limit)) return false;
    ids.add(limit.id);
  }
  return true;
}

function isValidUsageLimit(limit: UsageLimit): boolean {
  return Boolean(limit.id && limit.title) && hasValidAmounts(limit) && hasValidReset(limit);
}

function hasValidAmounts(limit: UsageLimit): boolean {
  const cap = limit.limit;
  return (
    Number.isFinite(limit.used) &&
    limit.used >= 0 &&
    (cap === null || (Number.isFinite(cap) && cap > 0))
  );
}

function hasValidReset(limit: UsageLimit): boolean {
  const reset = limit.resetsInMs;
  return reset === undefined || (Number.isFinite(reset) && reset >= 0);
}
