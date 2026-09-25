import { runProviderCommand } from "@pragma-sh/plugin/catalog";
import type { PluginContext, UsageLimit, UsageLimitsResult } from "@pragma-sh/plugin/catalog";

const RATE_LIMITS_REQUEST_ID = 2;
/** Metered bucket codex reports for the account's main quota. */
const CODEX_BUCKET_ID = "codex";
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
  const limits: UsageLimit[] = [];
  const emittedWindows = new Set<string>();
  for (const bucket of rateLimitBuckets(value)) {
    addRateLimitWindow(
      limits,
      emittedWindows,
      bucket,
      `${bucket.id}-primary`,
      "5-hour limit",
      bucket.snapshot.primary,
      observedAt,
    );
    addRateLimitWindow(
      limits,
      emittedWindows,
      bucket,
      `${bucket.id}-secondary`,
      "Weekly limit",
      bucket.snapshot.secondary,
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

/** One metered rate-limit bucket from `rateLimits` or `rateLimitsByLimitId`. */
interface RateLimitBucket {
  /** Normalized metered limit id, also the prefix of this bucket's limit ids. */
  id: string;
  /** Bucket name shown on non-default buckets (for example `gpt-reserve`). */
  label: string;
  snapshot: Record<string, unknown>;
}

/**
 * Merges the backward-compatible single-bucket `rateLimits` view with the
 * multi-bucket `rateLimitsByLimitId` map. The former mirrors one map entry under
 * the same `limitId`, so keying both by that id emits the bucket once; when the
 * map omits the default bucket the default snapshot still survives, keeping
 * `codex-primary` present. Every distinct bucket remains its own entry.
 */
function rateLimitBuckets(value: Record<string, unknown>): RateLimitBucket[] {
  const byId = new Map<string, RateLimitBucket>();
  const defaultSnapshot = isRecord(value.rateLimits) ? value.rateLimits : null;
  if (defaultSnapshot) {
    addRateLimitBucket(byId, defaultSnapshot, CODEX_BUCKET_ID);
  }
  const bucketRecord = isRecord(value.rateLimitsByLimitId) ? value.rateLimitsByLimitId : null;
  for (const [key, rawSnapshot] of Object.entries(bucketRecord ?? {})) {
    if (isRecord(rawSnapshot)) {
      // The authoritative multi-bucket view wins a collision with the mirror.
      addRateLimitBucket(byId, rawSnapshot, key);
    }
  }
  // Rust serializes the map from a HashMap, so its key order is arbitrary; sort so
  // the default bucket stays first and the rest render deterministically.
  return [...byId.values()].toSorted(compareBuckets);
}

function addRateLimitBucket(
  byId: Map<string, RateLimitBucket>,
  snapshot: Record<string, unknown>,
  fallbackId: string,
): void {
  const id = slug(stringValue(snapshot.limitId) ?? fallbackId) || CODEX_BUCKET_ID;
  byId.set(id, { id, label: stringValue(snapshot.limitName) ?? id, snapshot });
}

/** Orders the default `codex` bucket first, then every other bucket by id. */
function compareBuckets(a: RateLimitBucket, b: RateLimitBucket): number {
  if (a.id === b.id) {
    return 0;
  }
  if (a.id === CODEX_BUCKET_ID) {
    return -1;
  }
  if (b.id === CODEX_BUCKET_ID) {
    return 1;
  }
  return a.id.localeCompare(b.id);
}

function addRateLimitWindow(
  limits: UsageLimit[],
  emittedWindows: Set<string>,
  bucket: RateLimitBucket,
  id: string,
  fallbackTitle: string,
  value: unknown,
  observedAt: number,
): void {
  if (!isRecord(value) || !isFiniteNumber(value.usedPercent)) {
    return;
  }
  // One metered window can be exposed twice: the same snapshot mirrored by another
  // bucket, or a window-only bucket whose primary and secondary carry it. Identical
  // usage, duration, and reset describe one window and are emitted once; a different
  // percentage, duration, or reset is a distinct quota and stays.
  if (isDuplicateWindow(emittedWindows, value)) {
    return;
  }
  limits.push(rateLimitWindow(bucket, id, fallbackTitle, value, value.usedPercent, observedAt));
}

/** Records a metered window and reports whether an identical one came before it. */
function isDuplicateWindow(emittedWindows: Set<string>, window: Record<string, unknown>): boolean {
  const key = equivalentWindowKey(window);
  if (key === null) {
    return false;
  }
  if (emittedWindows.has(key)) {
    return true;
  }
  emittedWindows.add(key);
  return false;
}

/** Builds one normalized percentage window. */
function rateLimitWindow(
  bucket: RateLimitBucket,
  id: string,
  fallbackTitle: string,
  window: Record<string, unknown>,
  usedPercent: number,
  observedAt: number,
): UsageLimit {
  const duration = isFiniteNumber(window.windowDurationMins) ? window.windowDurationMins : null;
  const title = duration === null ? fallbackTitle : durationTitle(duration, fallbackTitle);
  const resetsAt = isFiniteNumber(window.resetsAt) ? window.resetsAt * 1000 : null;
  return {
    id,
    title: bucket.id === CODEX_BUCKET_ID ? title : `${bucket.label} ${lowercaseFirst(title)}`,
    used: Math.min(100, Math.max(0, usedPercent)),
    limit: 100,
    ...(resetsAt === null ? {} : { resetsInMs: Math.max(0, resetsAt - observedAt) }),
  };
}

/** Identity of one metered window; `null` when the response omits part of it. */
function equivalentWindowKey(window: Record<string, unknown>): string | null {
  if (
    !isFiniteNumber(window.usedPercent) ||
    !isFiniteNumber(window.windowDurationMins) ||
    !isFiniteNumber(window.resetsAt)
  ) {
    return null;
  }
  return JSON.stringify([window.usedPercent, window.windowDurationMins, window.resetsAt]);
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

function lowercaseFirst(value: string): string {
  return `${value[0]?.toLowerCase() ?? ""}${value.slice(1)}`;
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
