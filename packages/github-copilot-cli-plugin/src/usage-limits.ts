import { runProviderCommand } from "@pragma/plugin/catalog";
import type { PluginContext, UsageLimit, UsageLimitsResult } from "@pragma/plugin/catalog";

const QUOTA_REQUEST_ID = 2;
const COPILOT_DRAIN_SECONDS = 3;
const COPILOT_BILLING_CYCLE_MS = 30 * 24 * 60 * 60 * 1000;
const COPILOT_MESSAGES = [
  { jsonrpc: "2.0", id: 1, method: "connect", params: {} },
  { jsonrpc: "2.0", id: QUOTA_REQUEST_ID, method: "account.getQuota", params: {} },
];
const COPILOT_INPUT = COPILOT_MESSAGES.map(frameMessage).join("");
const COPILOT_USAGE_COMMAND =
  "command -v copilot >/dev/null 2>&1 || exit 20; " +
  `{ printf '%s' ${shellQuote(COPILOT_INPUT)}; sleep ${COPILOT_DRAIN_SECONDS}; } | ` +
  "copilot --headless --no-auto-update --log-level none --stdio";
// Agent sessions use an interactive shell, which is where fnm/nvm commonly adds Copilot to PATH.
const USAGE_COMMAND = `exec "\${SHELL:-/bin/sh}" -lic ${shellQuote(COPILOT_USAGE_COMMAND)}`;

/** Loads usage through Copilot CLI's authenticated runtime. */
export async function loadGitHubCopilotUsageLimits(ctx: PluginContext): Promise<UsageLimitsResult> {
  const outcome = await runProviderCommand(ctx, USAGE_COMMAND);
  if (outcome.kind === "missing") {
    return {
      status: "unavailable",
      reason: "not-configured",
      message: "Install GitHub Copilot CLI to load usage limits.",
    };
  }
  if (outcome.kind === "failed") {
    const detail = outcome.stderr || "GitHub Copilot usage request failed";
    if (/auth|credential|login|logged in|sign in|401|403/i.test(detail)) {
      return authenticationRequired();
    }
    throw new Error(detail);
  }
  return extractGitHubCopilotUsageLimits(outcome.stdout, Date.now());
}

/** Extracts Copilot's quota response from Content-Length-framed JSON-RPC output. */
export function extractGitHubCopilotUsageLimits(
  stdout: string,
  observedAt: number,
): UsageLimitsResult {
  for (const message of parseFramedMessages(stdout)) {
    if (!isRecord(message) || message.id !== QUOTA_REQUEST_ID) {
      continue;
    }
    if ("result" in message) {
      return parseGitHubCopilotUsageLimits(message.result, observedAt);
    }
    const detail = isRecord(message.error) ? stringValue(message.error.message) : null;
    if (detail && /auth|credential|login|logged in|sign in|401|403/i.test(detail)) {
      return authenticationRequired();
    }
    throw new Error(detail ?? "GitHub Copilot usage request failed");
  }
  throw new Error("GitHub Copilot CLI did not return usage data");
}

/** Normalizes Copilot runtime quota snapshots into Pragma usage limits. */
export function parseGitHubCopilotUsageLimits(
  value: unknown,
  observedAt: number,
): UsageLimitsResult {
  if (!isRecord(value)) {
    throw new Error("GitHub Copilot usage response was not an object");
  }
  const snapshots = isRecord(value.quotaSnapshots) ? value.quotaSnapshots : null;
  const quota = snapshots ? selectQuota(snapshots) : null;
  if (!quota) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: "GitHub Copilot CLI did not return a usable AI-credit allowance.",
    };
  }

  const unlimited = quota.isUnlimitedEntitlement === true;
  const entitlement = finiteNonnegative(quota.entitlementRequests);
  const used = finiteNonnegative(quota.usedRequests);
  if (used === null || (!unlimited && (entitlement === null || entitlement <= 0))) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: "GitHub Copilot CLI did not return a usable AI-credit allowance.",
    };
  }

  const resetAt = nextResetAt(quota.resetDate, observedAt);
  const reset = resetAt === null ? {} : { resetsInMs: Math.max(0, resetAt - observedAt) };
  const aiCredits: UsageLimit = {
    id: "ai-credits",
    title: "AI credits",
    used,
    limit: unlimited ? null : entitlement,
    ...reset,
  };
  return { status: "ready", observedAt, summary: aiCredits, limits: [aiCredits] };
}

function selectQuota(snapshots: Record<string, unknown>): Record<string, unknown> | null {
  const premium = isRecord(snapshots.premium_interactions) ? snapshots.premium_interactions : null;
  if (premium && hasAllowance(premium)) {
    return premium;
  }
  const chat = isRecord(snapshots.chat) ? snapshots.chat : null;
  return chat && hasAllowance(chat) ? chat : null;
}

function hasAllowance(quota: Record<string, unknown>): boolean {
  return (
    quota.isUnlimitedEntitlement === true ||
    (quota.hasQuota !== false && (finiteNonnegative(quota.entitlementRequests) ?? 0) > 0)
  );
}

function parseFramedMessages(stdout: string): unknown[] {
  const messages: unknown[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const output = encoder.encode(stdout);
  const separator = encoder.encode("\r\n\r\n");
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = indexOfBytes(output, separator, offset);
    if (headerEnd < 0) {
      break;
    }
    const headers = decoder.decode(output.subarray(offset, headerEnd));
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(headers);
    if (!match?.[1]) {
      offset = headerEnd + 4;
      continue;
    }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (bodyEnd > output.length) {
      break;
    }
    try {
      messages.push(JSON.parse(decoder.decode(output.subarray(bodyStart, bodyEnd))));
    } catch {
      // Ignore unrelated malformed frames and continue looking for quota response.
    }
    offset = bodyEnd;
  }
  return messages;
}

function frameMessage(value: unknown): string {
  const body = JSON.stringify(value);
  return `Content-Length: ${new TextEncoder().encode(body).byteLength}\r\n\r\n${body}`;
}

function indexOfBytes(output: Uint8Array, separator: Uint8Array, offset: number): number {
  const lastStart = output.length - separator.length;
  for (let index = offset; index <= lastStart; index += 1) {
    if (separator.every((byte, separatorIndex) => output[index + separatorIndex] === byte)) {
      return index;
    }
  }
  return -1;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function authenticationRequired(): UsageLimitsResult {
  return {
    status: "unavailable",
    reason: "authentication-required",
    message: "Sign in with GitHub Copilot CLI to load usage limits.",
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function dateValue(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nextResetAt(value: unknown, observedAt: number): number | null {
  const resetAt = dateValue(value);
  if (resetAt === null || resetAt > observedAt) {
    return resetAt;
  }
  const elapsedCycles = Math.floor((observedAt - resetAt) / COPILOT_BILLING_CYCLE_MS);
  return resetAt + (elapsedCycles + 1) * COPILOT_BILLING_CYCLE_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
