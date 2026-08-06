// Junie's account quota, read through the ACP `/usage` slash command.
//
// JetBrains reports a *remaining* balance only — `IngrazzioAuthInfo` carries
// `balanceLeft` plus its unit and the license type, and nothing anywhere in the
// CLI exposes the period's starting allowance. Pragma's `UsageLimit` is a
// used/limit pair, so the denominator is reconstructed from the highest balance
// this machine has observed (`~/.pragma/cache/junie-usage.json`): a balance only
// falls as credits are spent and only rises on a top-up or renewal, so the peak
// is exactly the current period's allowance once one full period has been seen.
// The first observation therefore reads 0% used and the bar becomes meaningful
// as the balance drops.
//
// Peak I/O goes through `ctx.sdk.exec.run`, never `node:fs`: the same bundle
// loads inside the production desktop webview (blob-URL import), where Node
// built-ins make the whole plugin fail to load, and a direct local read would
// also target the wrong machine for a remote project.
import type { PluginContext, UsageLimit, UsageLimitsResult } from "@pragma/plugin/catalog";

import { readJunieAcp, shellQuote } from "./acp";

/** Id of the category rendered in the provider's collapsed summary row. */
export const PRIMARY_LIMIT_ID = "credits";

/** Peak-cache path on the project's host (expanded by the shell). */
const PEAKS_DIR = '"$HOME"/.pragma/cache';
const PEAKS_FILE = `${PEAKS_DIR}/junie-usage.json`;

/** Bump when {@link PeaksFile} gains a field an older build would misread. */
const PEAKS_VERSION = 1;

/** One parsed `/usage` report. */
export interface JunieUsage {
  /** Junie's license name, e.g. `JetBrains Trial`. Null when unreported. */
  licenseType: string | null;
  /** Remaining balance in `unit`. */
  remaining: number;
  /** `$` for a money balance, `credits` for a credit balance. */
  unit: string;
}

/** On-disk peak cache, keyed by `<license>|<unit>`. */
export interface PeaksFile {
  version: number;
  peaks: Record<string, number>;
}

/** Loads Junie plan usage through its ACP `/usage` session command. */
export async function loadJunieUsageLimits(ctx: PluginContext): Promise<UsageLimitsResult> {
  const { missing, usageText } = await readJunieAcp(ctx, { usage: true });
  if (missing) {
    return {
      status: "unavailable",
      reason: "not-configured",
      message: "Install the Junie CLI to load usage limits.",
    };
  }
  if (usageText === null || usageText.trim() === "") {
    throw new Error("Junie returned no usage report");
  }
  if (/log ?in|sign ?in|authenticat|not authorized/i.test(usageText)) {
    return {
      status: "unavailable",
      reason: "authentication-required",
      message: "Run `junie` and sign in to your JetBrains account to load usage limits.",
    };
  }
  const usage = parseJunieUsage(usageText);
  if (usage === null) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: "Junie did not report a balance for this license.",
    };
  }
  const peak = await recordPeak(ctx, peakKey(usage), usage.remaining);
  return buildResult(usage, peak, Date.now());
}

/**
 * Extracts the balance from a `/usage` report.
 *
 * Junie renders one of two lines depending on the license: `Balance left: $4.99`
 * for a money balance, `Quota: 250 credits remaining` for a credit balance.
 * Anything else (notably the "check your quota by clicking the JetBrains AI
 * icon" text Junie prints when it runs inside an IDE) yields null.
 */
export function parseJunieUsage(text: string): JunieUsage | null {
  const licenseType = /^\s*-?\s*License:\s*(.+?)\s*$/m.exec(text)?.[1] ?? null;
  const money = /^\s*-?\s*Balance left:\s*([^\d\s]*)\s*([\d.,]+)\s*$/m.exec(text);
  if (money) {
    const remaining = parseAmount(money[2]);
    return remaining === null ? null : { licenseType, remaining, unit: money[1] || "$" };
  }
  const credits = /^\s*-?\s*Quota:\s*([\d.,]+)\s*(\S+)?\s*remaining\s*$/m.exec(text);
  if (credits) {
    const remaining = parseAmount(credits[1]);
    return remaining === null ? null : { licenseType, remaining, unit: credits[2] ?? "credits" };
  }
  return null;
}

/** Turns a parsed balance and its observed peak into Pragma's used/limit pair. */
export function buildResult(
  usage: JunieUsage,
  peak: number,
  observedAt: number,
): UsageLimitsResult {
  if (peak <= 0) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: `Junie reports no ${usage.unit === "$" ? "balance" : usage.unit} left.`,
    };
  }
  const limit: UsageLimit = {
    id: PRIMARY_LIMIT_ID,
    title: usage.licenseType === null ? "Credits" : `${usage.licenseType} credits`,
    used: Math.min(peak, Math.max(0, peak - usage.remaining)),
    limit: peak,
  };
  return { status: "ready", observedAt, limits: [limit] };
}

/** Cache key: a license change or a unit change starts its own period. */
export function peakKey(usage: JunieUsage): string {
  return `${usage.licenseType ?? "unknown"}|${usage.unit}`;
}

/**
 * Returns the highest balance seen for `key`, raising the stored peak first when
 * the current balance exceeds it. Cache failures are not fatal: a missing or
 * unreadable file just means the current balance becomes the peak.
 */
async function recordPeak(ctx: PluginContext, key: string, remaining: number): Promise<number> {
  const cwd = ctx.project?.path ?? "/tmp";
  const file = parsePeaksFile(await readPeaksText(ctx, cwd));
  const stored = file.peaks[key] ?? 0;
  if (remaining <= stored) {
    return stored;
  }
  file.peaks[key] = remaining;
  try {
    await writePeaksText(ctx, cwd, serializePeaksFile(file));
  } catch {
    // A read-only or unwritable home directory only costs us the history, not
    // the reading: the peak falls back to this observation for this refresh.
  }
  return remaining;
}

/** Reads the peak-cache file contents from the project's host. */
async function readPeaksText(ctx: PluginContext, cwd: string): Promise<string> {
  try {
    const [result] = await ctx.sdk.exec.run({
      cwd,
      commands: [`cat ${PEAKS_FILE} 2>/dev/null || true`],
    });
    return result?.stdout ?? "";
  } catch {
    return "";
  }
}

/** Writes the peak-cache file on the project's host. */
async function writePeaksText(ctx: PluginContext, cwd: string, contents: string): Promise<void> {
  const [result] = await ctx.sdk.exec.run({
    cwd,
    commands: [`mkdir -p ${PEAKS_DIR} && printf '%s\\n' ${shellQuote(contents)} > ${PEAKS_FILE}`],
  });
  if (!result || result.status !== 0) {
    throw new Error(result?.stderr.trim() || "failed to write Junie usage cache");
  }
}

/** Parses peak-cache JSON, treating any unusable payload as empty. */
export function parsePeaksFile(text: string): PeaksFile {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { version: PEAKS_VERSION, peaks: {} };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) {
      return { version: PEAKS_VERSION, peaks: {} };
    }
    const record = parsed as Partial<PeaksFile>;
    if (
      record.version !== PEAKS_VERSION ||
      typeof record.peaks !== "object" ||
      record.peaks === null
    ) {
      return { version: PEAKS_VERSION, peaks: {} };
    }
    const peaks: Record<string, number> = {};
    for (const [key, value] of Object.entries(record.peaks)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        peaks[key] = value;
      }
    }
    return { version: PEAKS_VERSION, peaks };
  } catch {
    return { version: PEAKS_VERSION, peaks: {} };
  }
}

/** Serializes a peak cache for the on-disk JSON file. */
export function serializePeaksFile(file: PeaksFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Parses `1,234.56` or `4.99` into a finite number, or null. */
function parseAmount(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseFloat(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}
