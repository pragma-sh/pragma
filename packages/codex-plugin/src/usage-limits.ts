import { runProviderCommand } from "@pragma/plugin/catalog";
import type { PluginContext, UsageLimit, UsageLimitsResult } from "@pragma/plugin/catalog";

const RATE_LIMITS_REQUEST_ID = 2;
// Keep stdin open long enough for slower app-server processes to flush their response.
const APP_SERVER_DRAIN_SECONDS = 3;
const APP_SERVER_MESSAGES = [
  {
    method: "initialize",
    id: 1,
    params: {
      clientInfo: { name: "pragma", title: "Pragma", version: "0.0.0" },
    },
  },
  { method: "initialized", params: {} },
  { method: "account/rateLimits/read", id: RATE_LIMITS_REQUEST_ID, params: {} },
];
const APP_SERVER_INPUT = APP_SERVER_MESSAGES.map((message) =>
  shellQuote(JSON.stringify(message)),
).join(" ");
const USAGE_COMMAND =
  `command -v codex >/dev/null 2>&1 || exit 20; ` +
  `{ printf '%s\\n' ${APP_SERVER_INPUT}; sleep ${APP_SERVER_DRAIN_SECONDS}; } | ` +
  "codex app-server --stdio";

/** Loads Codex plan limits through its supported app-server account API. */
export async function loadCodexUsageLimits(ctx: PluginContext): Promise<UsageLimitsResult> {
  const outcome = await runProviderCommand(ctx, USAGE_COMMAND);
  if (outcome.kind === "missing") {
    return {
      status: "unavailable",
      reason: "not-configured",
      message: "Install Codex CLI to load usage limits.",
    };
  }
  if (outcome.kind === "failed") {
    throw new Error(outcome.stderr || "Codex usage request failed");
  }
  return extractCodexUsageLimits(outcome.stdout, Date.now());
}

/** Scans app-server NDJSON output for the rate-limit response and normalizes it. */
export function extractCodexUsageLimits(stdout: string, observedAt: number): UsageLimitsResult {
  for (const line of stdout.split("\n")) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(message) || message.id !== RATE_LIMITS_REQUEST_ID) {
      continue;
    }
    if ("result" in message) {
      return parseCodexUsageLimits(message.result, observedAt);
    }
    const detail = isRecord(message.error) ? stringValue(message.error.message) : null;
    if (detail && /auth|login|api key/i.test(detail)) {
      return {
        status: "unavailable",
        reason: "authentication-required",
        message: "Sign in to Codex with ChatGPT to load usage limits.",
      };
    }
    throw new Error(detail ?? "Codex usage request failed");
  }
  throw new Error("Codex app-server did not return usage data");
}

/** Normalizes app-server `account/rateLimits/read` output. */
export function parseCodexUsageLimits(value: unknown, observedAt: number): UsageLimitsResult {
  if (!isRecord(value)) {
    throw new Error("Codex usage response was not an object");
  }
  const defaultSnapshot = isRecord(value.rateLimits) ? value.rateLimits : null;
  const bucketRecord = isRecord(value.rateLimitsByLimitId) ? value.rateLimitsByLimitId : null;
  const buckets = bucketRecord ? Object.entries(bucketRecord) : [];
  if (buckets.length === 0 && defaultSnapshot) {
    buckets.push(["codex", defaultSnapshot]);
  }

  const limits: UsageLimit[] = [];
  for (const [fallbackId, rawSnapshot] of buckets) {
    if (!isRecord(rawSnapshot)) {
      continue;
    }
    const baseId = slug(stringValue(rawSnapshot.limitId) ?? fallbackId) || "codex";
    addRateLimitWindow(
      limits,
      `${baseId}-primary`,
      "5-hour limit",
      rawSnapshot.primary,
      observedAt,
    );
    addRateLimitWindow(
      limits,
      `${baseId}-secondary`,
      "Weekly limit",
      rawSnapshot.secondary,
      observedAt,
    );
  }
  if (limits.length === 0) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: "Codex did not return plan rate-limit windows for this account.",
    };
  }
  return { status: "ready", observedAt, limits };
}

function addRateLimitWindow(
  limits: UsageLimit[],
  id: string,
  fallbackTitle: string,
  value: unknown,
  observedAt: number,
): void {
  if (!isRecord(value) || !isFiniteNumber(value.usedPercent)) {
    return;
  }
  const duration = isFiniteNumber(value.windowDurationMins) ? value.windowDurationMins : null;
  const title = duration === null ? fallbackTitle : durationTitle(duration, fallbackTitle);
  const resetsAt = isFiniteNumber(value.resetsAt) ? value.resetsAt * 1000 : null;
  limits.push({
    id,
    title,
    used: Math.min(100, Math.max(0, value.usedPercent)),
    limit: 100,
    ...(resetsAt === null ? {} : { resetsInMs: Math.max(0, resetsAt - observedAt) }),
  });
}

function durationTitle(minutes: number, fallback: string): string {
  if (minutes % (7 * 24 * 60) === 0) {
    const weeks = minutes / (7 * 24 * 60);
    return weeks === 1 ? "Weekly limit" : `${weeks}-week limit`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}-hour limit`;
  }
  return fallback;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
