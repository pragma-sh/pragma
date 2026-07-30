import {
  defineAgent,
  definePlugin,
  defineUsageLimitProvider,
  type AgentModelEntry,
  type PluginContext,
  type PluginDefinition,
} from "@pragma/plugin/catalog";
import { createTuiWatcher } from "@pragma/watcher-kit";

import { asRecord, asText, readGrokAcp } from "./acp";
import { loadGrokUsageLimits, PRIMARY_LIMIT_ID } from "./usage-limits";

export { loadGrokUsageLimits, parseGrokUsage } from "./usage-limits";

/** Lets grok's paste-aware composer commit interjected text before Enter. */
const INTERJECT_SUBMIT_DELAY_MS = 200;
/** Grok paints its TUI a few seconds after launch; type the prefill after it. */
const PREFILL_DELAY_MS = 4000;
/** `_x.ai/billing` spawns a short-lived agent process; don't poll it hard. */
const USAGE_REFRESH_INTERVAL_MS = 300_000;

const baseWatcher = createTuiWatcher({
  agent: "grok",
  // Grok has no permission-request hook at all (`PreToolUse` fires for *every*
  // tool, before the permission system runs, and can only allow or deny), so
  // command approvals are not brokered through Pragma and there is nothing for
  // the watcher to decide. It exists for mid-turn interjections.
  handleDecisions: false,
  interjectSubmitDelayMs: INTERJECT_SUBMIT_DELAY_MS,
});

/**
 * Pragma plugin for the Grok Build CLI, bundled to `dist/pragma-plugin.mjs`.
 *
 * Lifecycle reporting is a declarative hook bundle (`hooks/hooks.json` ->
 * `hooks/report.sh`) installed into grok's always-trusted `~/.grok/hooks/`
 * directory, because grok loads no in-process JavaScript plugin and (as of
 * 0.2.114) never dispatches plugin-provided hooks. This module contributes only
 * the Pragma-side launcher, model provider, usage-limit provider and watcher.
 */
export const grokAgentPlugin: PluginDefinition = definePlugin({
  name: "Grok",
  description: "Launch Grok Build from Pragma.",
  usageLimits: [
    defineUsageLimitProvider({
      id: "grok",
      title: "Grok",
      dashboardUrl: "https://grok.com/?_s=usage",
      iconPath: "assets/grok.svg",
      primaryLimitId: PRIMARY_LIMIT_ID,
      refreshIntervalMs: USAGE_REFRESH_INTERVAL_MS,
      load: loadGrokUsageLimits,
    }),
  ],
  watchers: [
    {
      agent: "grok",
      async watch(ctx) {
        try {
          await baseWatcher.watch(ctx);
        } finally {
          // `SessionEnd` already clears a graceful exit; this covers a session
          // killed hard enough that no hook runs.
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
      id: "grok",
      name: "Grok",
      icon: () => null,
      iconPath: "assets/grok.svg",
      launch: { command: ["grok"] },
      prefillDelayMs: PREFILL_DELAY_MS,
      prefillMode: "plain",
      prefillSubmit: "\r",
      models: loadGrokModels,
      // Grok exposes no `--permission-mode`; these are the real launch flags
      // that change how much it asks for.
      permissionModes: [
        { id: "default", name: "Ask for approval" },
        { id: "no-plan", name: "Skip plan mode" },
        { id: "always-approve", name: "Auto-approve tools" },
      ],
      // `commandApproval`: grok has no permission-request hook to block on.
      // `questions`: `ask_user_question` is owned by grok's own TUI and no hook
      // can return an answer to it, so Pragma raises attention but cannot reply.
      excludeFeatures: ["commandApproval", "questions"],
      args: {
        model: (modelId: string) => ["--model", modelId],
        reasoning: (reasoningId: string) => ["--reasoning-effort", reasoningId],
        permissionMode: (permissionModeId: string) => {
          if (permissionModeId === "always-approve") {
            return ["--always-approve"];
          }
          return permissionModeId === "no-plan" ? ["--no-plan"] : [];
        },
      },
    }),
  ],
});

export default grokAgentPlugin;

/**
 * Reads the launcher's model list from the ACP handshake. `grok models` prints
 * a human-readable list with no machine-readable flag, whereas `initialize`
 * returns the same catalog structured, including per-model reasoning efforts.
 */
export async function loadGrokModels(ctx: PluginContext): Promise<AgentModelEntry[]> {
  let snapshot;
  try {
    snapshot = await readGrokAcp(ctx);
  } catch {
    // The launcher must still open when grok cannot be queried (offline, not
    // signed in); grok then starts on its own configured default model.
    return [];
  }
  if (snapshot.missing || snapshot.initialize?.ok !== true) {
    return [];
  }
  return parseGrokModels(snapshot.initialize.result);
}

/** Normalizes the `initialize` result's `_meta.modelState` into launcher entries. */
export function parseGrokModels(value: unknown): AgentModelEntry[] {
  const models: AgentModelEntry[] = [];
  for (const candidate of records(metaOf(value).modelState?.availableModels)) {
    const id = asText(candidate.modelId);
    if (id === null) {
      continue;
    }
    const name = asText(candidate.name) ?? id;
    const reasoning = parseReasoning(metaOf(candidate));
    models.push(reasoning.length > 0 ? { id, name, reasoning } : { id, name });
  }
  return models;
}

/**
 * Reads the ACP-unstable `_meta` bag off a value, with nested records already
 * narrowed so callers can walk grok's optional metadata with `?.`.
 */
function metaOf(
  value: unknown,
): { modelState?: Record<string, unknown> } & Record<string, unknown> {
  const meta = asRecord(asRecord(value)?.["_meta"]) ?? {};
  return { ...meta, modelState: asRecord(meta.modelState) ?? undefined };
}

/** Keeps only the array entries that are plain objects. */
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    return record === null ? [] : [record];
  });
}

/** Reads a model's selectable reasoning efforts, if it supports any. */
function parseReasoning(meta: Record<string, unknown>): Array<{ id: string; name: string }> {
  if (meta.supportsReasoningEffort !== true) {
    return [];
  }
  const entries: Array<{ id: string; name: string }> = [];
  for (const effort of records(meta.reasoningEfforts)) {
    // `value` is what `--reasoning-effort` accepts; `id` repeats it today but
    // is the display key, so prefer `value` and fall back.
    const id = asText(effort.value) ?? asText(effort.id);
    if (id === null) {
      continue;
    }
    entries.push({ id, name: asText(effort.label) ?? titleCase(id) });
  }
  return entries;
}

function titleCase(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
