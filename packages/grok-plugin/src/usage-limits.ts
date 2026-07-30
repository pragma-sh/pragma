import type { PluginContext, UsageLimit, UsageLimitsResult } from "@pragma/plugin/catalog";

import { asNumber, asRecord, asText, readGrokAcp } from "./acp";

/** Id of the category rendered in the provider's collapsed summary row. */
export const PRIMARY_LIMIT_ID = "credits";

/** Loads Grok plan usage through its ACP `_x.ai/billing` extension method. */
export async function loadGrokUsageLimits(ctx: PluginContext): Promise<UsageLimitsResult> {
  const { missing, billing } = await readGrokAcp(ctx);
  if (missing) {
    return {
      status: "unavailable",
      reason: "not-configured",
      message: "Install the Grok CLI to load usage limits.",
    };
  }
  if (billing === undefined) {
    throw new Error("Grok did not return a billing response");
  }
  if (billing.ok) {
    return parseGrokUsage(billing.result, Date.now());
  }
  const detail = billing.message;
  if (detail !== null && /auth|login|sign in|credential/i.test(detail)) {
    return {
      status: "unavailable",
      reason: "authentication-required",
      message: "Run `grok login` to load usage limits.",
    };
  }
  throw new Error(detail ?? "Grok billing request failed");
}

/**
 * Normalizes grok's `_x.ai/billing` payload into generic usage limits.
 *
 * An account with no finite window at all (a free tier, which reports a period
 * and three zeroed money fields) is reported as `unsupported` rather than a row
 * of zeros — grok enforces a free ceiling that this API does not expose.
 */
export function parseGrokUsage(value: unknown, observedAt: number): UsageLimitsResult {
  const payload = asRecord(value);
  if (payload === null) {
    throw new Error("Grok billing response was not an object");
  }
  const config = asRecord(payload.config) ?? {};
  const resetsInMs = periodResetMs(config, observedAt);
  const limits = [primaryLimit(config, resetsInMs), onDemandLimit(config, resetsInMs)].filter(
    (limit) => limit !== null,
  );
  if (limits.length === 0) {
    const tier = asText(payload.subscription_tier);
    return {
      status: "unavailable",
      reason: "unsupported",
      message:
        tier === null
          ? "Grok did not report any usage windows for this account."
          : `Grok did not report usage windows for the ${tier} plan.`,
    };
  }
  return { status: "ready", observedAt, limits };
}

/**
 * The plan's own allowance. A metered account reports `creditUsagePercent`
 * against the current period; a seat-based one reports how much of
 * `monthlyLimit` is used instead.
 */
function primaryLimit(
  config: Record<string, unknown>,
  resetsInMs: number | null,
): UsageLimit | null {
  const title = periodTitle(config);
  const usedPercent = asNumber(config.creditUsagePercent);
  if (usedPercent !== null) {
    return {
      id: PRIMARY_LIMIT_ID,
      title,
      used: Math.min(100, Math.max(0, usedPercent)),
      limit: 100,
      ...(resetsInMs === null ? {} : { resetsInMs }),
    };
  }
  const limit = asNumber(config.monthlyLimit);
  const used = asNumber(config.includedUsed) ?? asNumber(config.totalUsed);
  if (limit === null || limit <= 0 || used === null) {
    return null;
  }
  return {
    id: PRIMARY_LIMIT_ID,
    title,
    used: Math.max(0, used),
    limit,
    ...(resetsInMs === null ? {} : { resetsInMs }),
  };
}

/** The pay-as-you-go window, present only once a spend cap is configured. */
function onDemandLimit(
  config: Record<string, unknown>,
  resetsInMs: number | null,
): UsageLimit | null {
  const limit = asNumber(config.onDemandCap);
  const used = asNumber(config.onDemandUsed);
  if (limit === null || limit <= 0 || used === null) {
    return null;
  }
  return {
    id: "on-demand",
    title: "On-demand spend",
    used: Math.max(0, used),
    limit,
    ...(resetsInMs === null ? {} : { resetsInMs }),
  };
}

/** Milliseconds until the current billing period ends. */
function periodResetMs(config: Record<string, unknown>, observedAt: number): number | null {
  const end = asText(asRecord(config.currentPeriod)?.end) ?? asText(config.billingPeriodEnd);
  if (end === null) {
    return null;
  }
  const parsed = Date.parse(end);
  return Number.isFinite(parsed) ? Math.max(0, parsed - observedAt) : null;
}

/** Names the primary window after grok's own period type. */
function periodTitle(config: Record<string, unknown>): string {
  const type = asText(asRecord(config.currentPeriod)?.type) ?? asText(config.billingCycle);
  if (type === null) {
    return "Credits";
  }
  if (/week/i.test(type)) {
    return "Weekly credits";
  }
  if (/month/i.test(type)) {
    return "Monthly credits";
  }
  return /day/i.test(type) ? "Daily credits" : "Credits";
}
