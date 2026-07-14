import {
  defineAgent,
  definePlugin,
  defineUsageLimitProvider,
  type AgentModelEntry,
  type PluginContext,
  type PluginDefinition,
  type UsageLimit,
  type UsageLimitsResult,
} from "@pragma/plugin/catalog";
import { createTuiWatcher } from "@pragma/watcher-kit";

/** Lets Cursor's paste-aware TUI commit interjected text before Enter. */
const INTERJECT_SUBMIT_DELAY_MS = 200;
const INSTALLED_CURSOR_USAGE_HELPER = "$HOME/.pragma/plugins/cursor/scripts/usage-limits.py";

/**
 * Pragma plugin for Cursor Agent, bundled to `dist/pragma-plugin.mjs` and
 * loaded by the pragma-plugins sidecar, the desktop webview, and the
 * `pragma-watch` sidecar alike. Approvals go through Cursor's blocking
 * `await-decision` hook, so the watcher only delivers interjections.
 */
export const cursorAgentPlugin: PluginDefinition = definePlugin({
  name: "Cursor Agent",
  description: "Launch Cursor Agent from Pragma.",
  usageLimits: [
    defineUsageLimitProvider({
      id: "cursor",
      title: "Cursor",
      dashboardUrl: "https://cursor.com/dashboard/spending",
      iconPath: "assets/cursor.svg",
      primaryLimitId: "api",
      refreshIntervalMs: 15_000,
      load: loadCursorUsageLimits,
    }),
  ],
  watchers: [
    createTuiWatcher({
      agent: "cursor",
      handleDecisions: false,
      interjectSubmitDelayMs: INTERJECT_SUBMIT_DELAY_MS,
    }),
  ],
  agents: [
    defineAgent({
      id: "cursor",
      name: "Cursor Agent",
      icon: () => null,
      iconPath: "assets/cursor.svg",
      launch: { command: ["agent", "--force", "--approve-mcps"] },
      startupInput: [{ delayMs: 5000, data: "a" }],
      prefillDelayMs: 14000,
      prefillMode: "plain",
      prefillSubmit: "\r",
      // `cursor-agent` first: Cursor's short `agent` name is easily shadowed by
      // other CLIs that also install an `agent` binary (e.g. grok), which made
      // the model list come back empty (or wrong) in host-side shells.
      models: async (ctx) =>
        parseCursorModels(
          await execFirst(ctx, "cursor-agent models 2>/dev/null || agent models 2>/dev/null"),
        ),
      permissionModes: [],
      args: {
        model: (modelId: string) => ["--model", modelId],
        reasoning: () => [],
        modelReasoning: (modelId: string, reasoningId: string) => [
          "--model",
          `${modelId}[effort=${reasoningId}]`,
        ],
        permissionMode: () => [],
      },
    }),
  ],
});

export default cursorAgentPlugin;

async function execFirst(ctx: PluginContext, command: string): Promise<string> {
  const cwd = ctx.project?.path ?? "/tmp";
  const [result] = await ctx.sdk.exec.run({ cwd, commands: [command] });
  return result?.stdout ?? "";
}

/** Loads Cursor account usage using credentials created by `cursor-agent login`. */
export async function loadCursorUsageLimits(ctx: PluginContext): Promise<UsageLimitsResult> {
  const cwd = ctx.project?.path ?? "/tmp";
  const bundledHelper = ctx.pluginDir ? `${ctx.pluginDir}/assets/usage-limits.py` : null;
  const helperFallback = bundledHelper
    ? `elif test -f ${shellQuote(bundledHelper)}; then helper=${shellQuote(bundledHelper)}; `
    : "";
  const script = `if test -f "${INSTALLED_CURSOR_USAGE_HELPER}"; then helper="${INSTALLED_CURSOR_USAGE_HELPER}"; ${helperFallback}else exit 20; fi; python3 "$helper"`;
  const command = `/bin/sh -c ${shellQuote(script)}`;
  const [result] = await ctx.sdk.exec.run({ cwd, commands: [command] });
  if (result?.status === 20) {
    return {
      status: "unavailable",
      reason: "not-configured",
      message: "Reinstall the Cursor integration to enable usage limits.",
    };
  }
  if (!result || result.status !== 0) {
    throw new Error(result?.stderr.trim() || "Cursor usage helper failed");
  }
  const value: unknown = JSON.parse(result.stdout);
  if (isUnavailableResult(value)) {
    return value;
  }
  return parseCursorUsageSummary(value, Date.now());
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Normalizes Cursor's private usage-summary response into generic usage limits. */
export function parseCursorUsageSummary(value: unknown, observedAt: number): UsageLimitsResult {
  if (!isRecord(value)) {
    throw new Error("Cursor usage response was not an object");
  }
  const resetTime = parseDate(value.billingCycleEnd);
  const resetsInMs = resetTime === null ? undefined : Math.max(0, resetTime - observedAt);
  const individual = recordValue(value.individualUsage);
  const plan = recordValue(individual?.plan);
  const apiPercent = usagePercent(plan?.apiPercentUsed);
  const firstPartyPercent = usagePercent(plan?.autoPercentUsed);
  if (apiPercent === null || firstPartyPercent === null) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: "Cursor did not return API and first-party usage for this account.",
    };
  }
  const reset = resetsInMs === undefined ? {} : { resetsInMs };
  const limits: UsageLimit[] = [
    { id: "api", title: "API usage", used: apiPercent, limit: 100, ...reset },
    {
      id: "first-party",
      title: "First-party usage",
      used: firstPartyPercent,
      limit: 100,
      ...reset,
    },
  ];
  return {
    status: "ready",
    observedAt,
    summary: {
      id: "average",
      title: "Average usage",
      used: (apiPercent + firstPartyPercent) / 2,
      limit: 100,
      ...reset,
    },
    limits,
  };
}

function usagePercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : null;
}

function parseDate(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnavailableResult(
  value: unknown,
): value is UsageLimitsResult & { status: "unavailable" } {
  return (
    isRecord(value) &&
    value.status === "unavailable" &&
    (value.reason === "not-configured" ||
      value.reason === "authentication-required" ||
      value.reason === "unsupported") &&
    typeof value.message === "string"
  );
}

/** Parses Cursor Agent's `models` output into model entries with effort levels. */
export function parseCursorModels(output: string): AgentModelEntry[] {
  const byId = new Map<string, AgentModelEntry>();
  for (const line of output.split("\n")) {
    const model = parseCursorModelLine(line);
    if (!model) {
      continue;
    }
    const entry = byId.get(model.baseId) ?? {
      id: model.baseId,
      name: cleanCursorName(model.name, model.effort),
      reasoning: [],
    };
    if (model.effort && entry.reasoning?.every((item) => item.id !== model.effort)) {
      entry.reasoning.push({ id: model.effort, name: effortName(model.effort) });
    }
    byId.set(model.baseId, entry);
  }
  return [...byId.values()].map((model) =>
    model.reasoning?.length ? model : { id: model.id, name: model.name },
  );
}

function parseCursorModelLine(
  line: string,
): { baseId: string; name: string; effort: string | null } | null {
  if (!line.includes(" - ")) {
    return null;
  }
  const [rawId, rawName] = line.split(" - ", 2);
  const id = rawId?.trim();
  const name = rawName?.trim();
  if (!id || id === "auto" || !name || /\s/.test(id)) {
    return null;
  }
  return { ...splitCursorEffort(id), name };
}

function splitCursorEffort(id: string): { baseId: string; effort: string | null } {
  const fast = id.endsWith("-fast");
  const withoutFast = fast ? id.slice(0, -5) : id;
  for (const effort of ["extra-high", "xhigh", "medium", "high", "low", "max", "none"]) {
    if (withoutFast.endsWith(`-${effort}`)) {
      const base = withoutFast.slice(0, -effort.length - 1);
      return { baseId: fast ? `${base}-fast` : base, effort };
    }
  }
  return { baseId: id, effort: null };
}

function cleanCursorName(name: string, effort: string | null): string {
  return effort
    ? name.replace(new RegExp(`\\s+${effortName(effort)}(?=\\s|$)`, "i"), "").trim()
    : name;
}

function effortName(effort: string): string {
  return effort === "xhigh" || effort === "extra-high"
    ? "Extra High"
    : `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1)}`;
}
