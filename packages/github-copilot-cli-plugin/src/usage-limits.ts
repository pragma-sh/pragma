import type { PluginContext, UsageLimit, UsageLimitsResult } from "@pragma/plugin/catalog";

const USAGE_COMMAND =
  "command -v gh >/dev/null 2>&1 || exit 20; " +
  "gh auth token >/dev/null 2>&1 || exit 21; " +
  "gh api copilot_internal/user -H 'Accept: application/json'";

/** Loads GitHub Copilot account usage through the authenticated GitHub CLI. */
export async function loadGitHubCopilotUsageLimits(ctx: PluginContext): Promise<UsageLimitsResult> {
  const [result] = await ctx.sdk.exec.run({
    cwd: ctx.project?.path ?? "/tmp",
    commands: [USAGE_COMMAND],
  });
  if (result?.status === 20) {
    return {
      status: "unavailable",
      reason: "not-configured",
      message: "Install GitHub CLI to load Copilot usage limits.",
    };
  }
  if (result?.status === 21) {
    return {
      status: "unavailable",
      reason: "authentication-required",
      message: "Sign in with GitHub CLI to load Copilot usage limits.",
    };
  }
  if (!result || result.status !== 0) {
    const detail = result?.stderr.trim() || "GitHub Copilot usage request failed";
    if (/authentication|not logged|401|403/i.test(detail)) {
      return {
        status: "unavailable",
        reason: "authentication-required",
        message: "Sign in with GitHub CLI to load Copilot usage limits.",
      };
    }
    throw new Error(detail);
  }
  return parseGitHubCopilotUsageLimits(JSON.parse(result.stdout), Date.now());
}

/** Normalizes GitHub's Copilot quota snapshot into Pragma usage limits. */
export function parseGitHubCopilotUsageLimits(
  value: unknown,
  observedAt: number,
): UsageLimitsResult {
  if (!isRecord(value)) {
    throw new Error("GitHub Copilot usage response was not an object");
  }
  const snapshots = isRecord(value.quota_snapshots) ? value.quota_snapshots : null;
  const premium =
    snapshots && isRecord(snapshots.premium_interactions) ? snapshots.premium_interactions : null;
  if (!premium) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: "GitHub did not return Copilot AI-credit usage for this account.",
    };
  }

  const entitlement = finiteNonnegative(premium.entitlement);
  const overageEntitlement = finiteNonnegative(premium.overage_entitlement) ?? 0;
  const limit = entitlement === null ? null : entitlement + overageEntitlement;
  const creditsUsed = finiteNonnegative(premium.credits_used);
  const remaining = finiteNumber(premium.remaining);
  const used = creditsUsed ?? (limit !== null && remaining !== null ? limit - remaining : null);
  if (used === null || (limit !== null && limit <= 0)) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: "GitHub did not return a usable Copilot AI-credit allowance.",
    };
  }

  const resetAt = dateValue(value.quota_reset_date_utc) ?? dateValue(value.quota_reset_date);
  const reset = resetAt === null ? {} : { resetsInMs: Math.max(0, resetAt - observedAt) };
  const aiCredits: UsageLimit = {
    id: "ai-credits",
    title: "AI credits",
    used: Math.max(0, used),
    limit,
    ...reset,
  };
  return { status: "ready", observedAt, summary: aiCredits, limits: [aiCredits] };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteNonnegative(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, number);
}

function dateValue(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
