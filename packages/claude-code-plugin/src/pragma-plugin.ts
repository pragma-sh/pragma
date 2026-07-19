import {
  defineAgent,
  definePlugin,
  defineUsageLimitProvider,
  type PluginContext,
  type PluginDefinition,
  type UsageLimit,
  type UsageLimitsResult,
} from "@pragma/plugin/catalog";
import { createTuiWatcher } from "@pragma/watcher-kit";

/** Lets Claude Code's paste-aware TUI commit interjected text before Enter. */
const INTERJECT_SUBMIT_DELAY_MS = 200;
const USAGE_REQUEST = JSON.stringify({
  type: "control_request",
  request_id: "pragma-usage",
  request: { subtype: "get_usage" },
});
const USAGE_COMMAND = `printf '%s\\n' '${USAGE_REQUEST}' | claude -p --safe-mode --input-format stream-json --output-format stream-json --verbose`;

const reasoningFull = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra High" },
  { id: "max", name: "Max" },
];
const reasoningStandard = reasoningFull.slice(0, 3);

/**
 * Pragma plugin for Claude Code, bundled to `dist/pragma-plugin.mjs` and loaded
 * by the pragma-plugins sidecar, the desktop webview, and the `pragma-watch`
 * sidecar alike. Approvals go through Claude Code's blocking `await-decision`
 * hook, so the watcher only delivers interjections (`handleDecisions: false`).
 */
export const claudeCodeAgentPlugin: PluginDefinition = definePlugin({
  name: "Claude Code",
  description: "Launch Claude Code from Pragma.",
  usageLimits: [
    defineUsageLimitProvider({
      id: "claude-code",
      title: "Claude Code",
      dashboardUrl: "https://claude.ai/new#settings/usage",
      iconPath: "assets/claude-code.svg",
      primaryLimitId: "five-hour",
      // Each refresh spawns a headless `claude -p` session that queries Anthropic's
      // strictly rate-limited OAuth usage endpoint; polling faster causes 429s.
      refreshIntervalMs: 300_000,
      load: loadClaudeUsageLimits,
    }),
  ],
  watchers: [
    createTuiWatcher({
      agent: "claude-code",
      handleDecisions: false,
      interjectSubmitDelayMs: INTERJECT_SUBMIT_DELAY_MS,
    }),
  ],
  agents: [
    defineAgent({
      id: "claude-code",
      name: "Claude Code",
      icon: () => null,
      iconPath: "assets/claude-code.svg",
      launch: { command: ["claude", "--permission-mode", "auto"] },
      models: [
        { id: "sonnet", name: "Sonnet", reasoning: reasoningFull },
        { id: "opus", name: "Opus", reasoning: reasoningStandard },
        { id: "fable", name: "Fable", reasoning: reasoningFull },
        { id: "haiku", name: "Haiku", reasoning: reasoningStandard },
      ],
      permissionModes: [],
      args: {
        model: (modelId: string) => ["--model", modelId],
        reasoning: (reasoningId: string) => ["--effort", reasoningId],
        permissionMode: () => [],
      },
    }),
  ],
});

export default claudeCodeAgentPlugin;

/** Loads plan usage through Claude Code's structured `/usage` control request. */
export async function loadClaudeUsageLimits(ctx: PluginContext): Promise<UsageLimitsResult> {
  const cwd = ctx.project?.path ?? "/tmp";
  const [result] = await ctx.sdk.exec.run({ cwd, commands: [USAGE_COMMAND] });
  if (!result || result.status !== 0) {
    throw new Error(result?.stderr.trim() || "Claude Code usage request failed");
  }
  return extractUsageFromOutput(result.stdout);
}

/** Scans NDJSON control-response output for the usage reply and normalizes it. */
function extractUsageFromOutput(stdout: string): UsageLimitsResult {
  for (const line of stdout.split("\n")) {
    const response = tryParseUsageControlResponse(line);
    if (response === undefined) {
      continue;
    }
    if (response.subtype === "error") {
      throw new Error(response.error || "Claude Code usage request failed");
    }
    return parseClaudeUsage(response.response, Date.now());
  }
  throw new Error("Claude Code did not return usage data");
}

/** Parses one NDJSON line as a usage control response, ignoring non-matching or malformed lines. */
function tryParseUsageControlResponse(
  line: string,
): { subtype: "success"; response: unknown } | { subtype: "error"; error?: string } | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isUsageControlResponse(value) ? value.response : undefined;
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      return undefined;
    }
    throw cause;
  }
}

/** Normalizes Claude Code's structured `/usage` response into generic usage limits. */
export function parseClaudeUsage(value: unknown, observedAt: number): UsageLimitsResult {
  if (!isRecord(value)) {
    throw new Error("Claude Code usage response was not an object");
  }
  if (value.rate_limits_available !== true) {
    return {
      status: "unavailable",
      reason: "authentication-required",
      message: "Sign in to Claude Code with a subscription to load usage limits.",
    };
  }
  if (!isRecord(value.rate_limits)) {
    // Signed in, but the CLI's usage fetch returned no data — usually a transient
    // 429 from the usage endpoint. Throwing (instead of returning "unavailable")
    // keeps the host's last snapshot and triggers its retry backoff.
    throw new Error("Claude Code usage data is temporarily unavailable (rate limited)");
  }

  const rateLimits = value.rate_limits;
  const limits: UsageLimit[] = [];
  addWindow(limits, "five-hour", "5-hour limit", rateLimits.five_hour, observedAt);
  addWindow(limits, "seven-day", "Weekly limit", rateLimits.seven_day, observedAt);
  addWindow(
    limits,
    "seven-day-oauth-apps",
    "Weekly OAuth apps",
    rateLimits.seven_day_oauth_apps,
    observedAt,
  );
  addWindow(limits, "seven-day-opus", "Weekly Opus", rateLimits.seven_day_opus, observedAt);
  addWindow(limits, "seven-day-sonnet", "Weekly Sonnet", rateLimits.seven_day_sonnet, observedAt);

  if (Array.isArray(rateLimits.model_scoped)) {
    for (const [index, scoped] of rateLimits.model_scoped.entries()) {
      if (!isRecord(scoped) || typeof scoped.display_name !== "string") {
        continue;
      }
      addWindow(
        limits,
        `model-${index}`,
        scoped.display_name,
        { utilization: scoped.utilization, resets_at: scoped.resets_at },
        observedAt,
      );
    }
  }

  if (!limits.some((limit) => limit.id === "five-hour")) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: "Claude Code did not return its 5-hour usage limit.",
    };
  }
  return { status: "ready", observedAt, limits };
}

function addWindow(
  limits: UsageLimit[],
  id: string,
  title: string,
  value: unknown,
  observedAt: number,
): void {
  if (!isRecord(value) || !isFiniteNumber(value.utilization)) {
    return;
  }
  const resetAt = parseDate(value.resets_at);
  limits.push({
    id,
    title,
    used: Math.min(100, Math.max(0, value.utilization)),
    limit: 100,
    ...(resetAt === null ? {} : { resetsInMs: Math.max(0, resetAt - observedAt) }),
  });
}

function parseDate(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUsageControlResponse(value: unknown): value is {
  type: "control_response";
  response: { subtype: "success"; response: unknown } | { subtype: "error"; error?: string };
} {
  if (!isRecord(value) || value.type !== "control_response" || !isRecord(value.response)) {
    return false;
  }
  return (
    (value.response.subtype === "success" && "response" in value.response) ||
    value.response.subtype === "error"
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
