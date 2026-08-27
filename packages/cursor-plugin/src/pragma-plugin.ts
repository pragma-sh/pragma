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
const baseWatcher = createTuiWatcher({
  agent: "cursor",
  handleDecisions: false,
  interjectSubmitDelayMs: INTERJECT_SUBMIT_DELAY_MS,
});
const INSTALLED_CURSOR_USAGE_HELPER = "$HOME/.pragma/plugins/cursor/scripts/usage-limits";

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
      refreshIntervalMs: 5 * 60_000,
      load: loadCursorUsageLimits,
    }),
  ],
  watchers: [
    {
      agent: "cursor",
      async watch(ctx) {
        try {
          await Promise.all([baseWatcher.watch(ctx), watchCursorTitles(ctx)]);
        } finally {
          try {
            await ctx.sdk.agents.report({
              agent: ctx.agentId,
              tabId: ctx.session.tabId,
              worktreeId: ctx.session.worktreeId,
              status: "cleared",
              attentionKind: null,
            });
          } catch {
            // Session-exit cleanup must never disrupt watcher shutdown.
          }
        }
      },
    },
  ],
  agents: [
    defineAgent({
      id: "cursor",
      name: "Cursor Agent",
      icon: () => null,
      iconPath: "assets/cursor.svg",
      launch: { command: ["cursor-agent", "--force", "--approve-mcps"] },
      excludeFeatures: ["commandApproval", "subagents", "abort", "interrupt"],
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

const CURSOR_QUESTION_TITLE = /^(?:choice asker|ask question)$/i;
const CURSOR_ACTIVE_TITLE = /^cursor agent$/i;

/** Reports Cursor's question state from OSC window titles in its PTY output. */
async function watchCursorTitles(ctx: Parameters<NonNullable<typeof baseWatcher.watch>>[0]) {
  let buffer = "";
  let awaitingQuestion = false;
  try {
    for await (const chunk of ctx.output) {
      buffer += chunk;
      // oxlint-disable-next-line no-control-regex -- OSC framing is defined by ESC and BEL bytes.
      const titlePattern = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
      let consumed = 0;
      for (const match of buffer.matchAll(titlePattern)) {
        consumed = (match.index ?? 0) + match[0].length;
        const title = match[1]?.trim() ?? "";
        if (CURSOR_QUESTION_TITLE.test(title) && !awaitingQuestion) {
          awaitingQuestion = true;
          await reportCursorStatus(ctx, "attention", "question");
        } else if (CURSOR_ACTIVE_TITLE.test(title) && awaitingQuestion) {
          awaitingQuestion = false;
          await reportCursorStatus(ctx, "running", null);
        }
      }
      buffer = consumed > 0 ? buffer.slice(consumed) : buffer.slice(-4096);
    }
  } catch {
    // Output transport may reconnect independently; keep watcher alive until session exit.
  }
  await waitForAbort(ctx.signal);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

async function reportCursorStatus(
  ctx: Parameters<NonNullable<typeof baseWatcher.watch>>[0],
  status: "running" | "attention",
  attentionKind: "question" | null,
): Promise<void> {
  try {
    await ctx.sdk.agents.report({
      agent: ctx.agentId,
      tabId: ctx.session.tabId,
      worktreeId: ctx.session.worktreeId,
      status,
      attentionKind,
    });
  } catch {
    // Status reporting must never disrupt Cursor's terminal stream.
  }
}

async function execFirst(ctx: PluginContext, command: string): Promise<string> {
  const cwd = ctx.project?.path ?? "/tmp";
  const [result] = await ctx.sdk.exec.run({ cwd, commands: [command] });
  return result?.stdout ?? "";
}

/** Loads Cursor account usage using credentials created by `cursor-agent login`. */
export async function loadCursorUsageLimits(ctx: PluginContext): Promise<UsageLimitsResult> {
  const cwd = ctx.project?.path ?? "/tmp";
  const bundledHelper = ctx.pluginDir ? `${ctx.pluginDir}/dist/usage-limits` : null;
  const [installed] = await ctx.sdk.exec.run({
    cwd,
    commands: [`node "${INSTALLED_CURSOR_USAGE_HELPER}"`],
  });
  const [fallback] =
    installed?.status !== 0 && bundledHelper
      ? await ctx.sdk.exec.run({ cwd, commands: [`node ${shellQuote(bundledHelper)}`] })
      : [];
  const result = fallback ?? installed;
  if (!result || (installed?.status !== 0 && fallback?.status !== 0)) {
    const stderr = `${installed?.stderr ?? ""}\n${fallback?.stderr ?? ""}`;
    if (!/MODULE_NOT_FOUND|cannot find module|not recognized|not found/i.test(stderr)) {
      return {
        status: "unavailable",
        reason: "unsupported",
        message: "Cursor usage is temporarily unavailable. Pragma will retry automatically.",
      };
    }
    return {
      status: "unavailable",
      reason: "not-configured",
      message: "Reinstall the Cursor integration to enable usage limits.",
    };
  }
  if (!result || result.status !== 0) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: "Cursor usage is temporarily unavailable. Pragma will retry automatically.",
    };
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
  if (!id || !name || /\s/.test(id)) {
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
