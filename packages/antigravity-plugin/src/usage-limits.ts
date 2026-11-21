// Antigravity quota, read from `agy -p /usage --output-format json`.
//
// Print mode answers `/usage` without starting a turn, spending quota, or
// leaving a conversation behind, and its JSON carries the structured quota
// under `command.data.groups[].buckets[]`: one group per model family (Gemini;
// Claude and GPT), each with a weekly and a 5-hour bucket, as a
// `remaining_fraction` plus an ISO `reset_time`.
//
// Host I/O goes through `ctx.sdk.exec.run`, never `node:child_process`: this
// bundle also loads in the desktop webview, and a remote project's quota lives
// on its own host.
import type { PluginContext, UsageLimit, UsageLimitsResult } from "@pragma-sh/plugin/catalog";

import { asRecord, asRecords, parseRecord } from "./json";

/** Category rendered in the provider's collapsed row: the Gemini 5-hour window. */
export const PRIMARY_LIMIT_ID = "gemini-5h";

/** Percent scale used for every bucket: agy reports fractions, not counts. */
const PERCENT = 100;

const USAGE_COMMAND = "agy -p /usage --output-format json";
/** `sh` exit status for a command that is not on PATH. */
const COMMAND_NOT_FOUND = 127;

/** Loads the signed-in account's quota buckets. */
export async function loadAntigravityUsageLimits(ctx: PluginContext): Promise<UsageLimitsResult> {
  const [result] = await ctx.sdk.exec.run({
    cwd: ctx.project?.path ?? "/tmp",
    commands: [USAGE_COMMAND],
  });
  if (!result) {
    throw new Error("Antigravity usage command returned no result");
  }
  if (result.status === COMMAND_NOT_FOUND) {
    return {
      status: "unavailable",
      reason: "not-configured",
      message: "Install the Antigravity CLI (`agy`) to load usage limits.",
    };
  }
  return parseAntigravityUsage(result.stdout, Date.now());
}

/** Converts `/usage` JSON into Pragma's used/limit categories. */
export function parseAntigravityUsage(stdout: string, observedAt: number): UsageLimitsResult {
  const document = parseJson(stdout);
  if (document === null) {
    if (/sign(ed)? ?in|log ?in|authenticat/i.test(stdout)) {
      return signInRequired();
    }
    throw new Error("Antigravity returned no usage report");
  }
  if (document.status !== "SUCCESS") {
    return signInRequired();
  }
  const groups = asRecord(asRecord(document.command)?.data)?.groups;
  const limits: UsageLimit[] = [];
  for (const group of asRecords(groups)) {
    const family = typeof group.name === "string" ? group.name : "Models";
    for (const bucket of asRecords(group.buckets)) {
      const limit = bucketLimit(family, bucket, observedAt);
      if (limit !== null) limits.push(limit);
    }
  }
  if (limits.length === 0) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: "Antigravity reported no quota for this account.",
    };
  }
  return { status: "ready", observedAt, limits };
}

function bucketLimit(
  family: string,
  bucket: Record<string, unknown>,
  observedAt: number,
): UsageLimit | null {
  const id = typeof bucket.id === "string" ? bucket.id : null;
  const remaining = bucket.remaining_fraction;
  if (id === null || typeof remaining !== "number" || !Number.isFinite(remaining)) {
    return null;
  }
  const fraction = Math.min(1, Math.max(0, remaining));
  const limit: UsageLimit = {
    id,
    title: `${family} · ${windowLabel(bucket)}`,
    used: Math.round((1 - fraction) * PERCENT * 10) / 10,
    limit: PERCENT,
  };
  const resetAt = typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN;
  if (Number.isFinite(resetAt)) {
    limit.resetsInMs = Math.max(0, resetAt - observedAt);
  }
  return limit;
}

function windowLabel(bucket: Record<string, unknown>): string {
  if (bucket.window === "5h") return "5-hour";
  if (bucket.window === "weekly") return "Weekly";
  return typeof bucket.name === "string" ? bucket.name : "Quota";
}

function signInRequired(): UsageLimitsResult {
  return {
    status: "unavailable",
    reason: "authentication-required",
    message: "Run `agy` and sign in to your Google account to load usage limits.",
  };
}

/** The JSON document in `stdout`, skipping any banner agy prints before it. */
function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  return start < 0 ? null : parseRecord(text.slice(start));
}
