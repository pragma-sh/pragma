import {
  defineAgent,
  definePlugin,
  defineUsageLimitProvider,
  type AgentModelEntry,
  type PluginContext,
  type PluginDefinition,
} from "@pragma/plugin/catalog";
import { createTuiWatcher } from "@pragma/watcher-kit";

import { asRecord, asText, readJunieAcp } from "./acp";
import { loadJunieUsageLimits, PRIMARY_LIMIT_ID } from "./usage-limits";

export { loadJunieUsageLimits, parseJunieUsage } from "./usage-limits";

/** Junie boots a JVM and paints its TUI a few seconds later; prefill after it. */
const PREFILL_DELAY_MS = 6000;
/** Each refresh spawns a short-lived `junie --acp=true` JVM; don't poll it hard. */
const USAGE_REFRESH_INTERVAL_MS = 900_000;

const baseWatcher = createTuiWatcher({
  agent: "junie",
  // Command approvals go through Junie's blocking `PermissionRequest` hook (see
  // hooks/report.sh), so the watcher must not also answer them.
  handleDecisions: false,
  // Questions are different: `ask_user` / `ask_user_choice` are ordinary tools
  // whose prompt Junie's own TUI owns, and no hook can return an answer to
  // them, so a remote reply has to arrive as keystrokes.
  handleQuestionAnswers: true,
  // Junie's question list ignores digit shortcuts: it navigates with Down,
  // marks the row with Space ("space to select"), and submits with Enter.
  questionSelectMode: "arrow-space",
  // Selection opens Junie's answer summary; one more Enter submits it.
  questionFinalizeKeys: "\r",
});

/**
 * Pragma plugin for the JetBrains Junie CLI, bundled to `dist/pragma-plugin.mjs`.
 *
 * Lifecycle reporting is a declarative hook bundle (`hooks/hooks.json` ->
 * `hooks/report.sh`) merged into Junie's global `~/.junie/config.json` by
 * `scripts/install-local.ts`, because Junie loads no in-process JavaScript
 * plugin and ignores project-local hook config by default. This module
 * contributes only the Pragma-side launcher, model provider, usage-limit
 * provider and watcher.
 */
export const junieAgentPlugin: PluginDefinition = definePlugin({
  name: "Junie",
  description: "Launch the JetBrains Junie CLI from Pragma.",
  usageLimits: [
    defineUsageLimitProvider({
      id: "junie",
      title: "Junie",
      dashboardUrl: "https://junie.jetbrains.com/cli",
      iconPath: "assets/junie.svg",
      primaryLimitId: PRIMARY_LIMIT_ID,
      refreshIntervalMs: USAGE_REFRESH_INTERVAL_MS,
      load: loadJunieUsageLimits,
    }),
  ],
  watchers: [
    {
      agent: "junie",
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
      id: "junie",
      name: "Junie",
      icon: () => null,
      iconPath: "assets/junie.svg",
      launch: { command: ["junie"] },
      prefillDelayMs: PREFILL_DELAY_MS,
      prefillMode: "plain",
      prefillSubmit: "\r",
      models: loadJunieModels,
      // Junie's approval behaviour is the `brave_mode` setting, whose only
      // command-line lever is `--brave` (equivalent to `Brave: on`). Leaving it
      // off keeps whatever the user configured, which defaults to `auto`.
      permissionModes: [
        { id: "default", name: "Ask for approval" },
        { id: "brave", name: "Brave mode (no approvals)" },
      ],
      // `subagents`: Junie runs subagents inside the same process and fires no
      // per-agent hook (`PreToolUse` carries no agent or session id), so their
      // start and finish are not observable from a hook bridge.
      excludeFeatures: ["subagents"],
      args: {
        model: (modelId: string) => ["--model", modelId],
        reasoning: (reasoningId: string) => ["--effort", reasoningId],
        permissionMode: (permissionModeId: string) =>
          permissionModeId === "brave" ? ["--brave"] : [],
      },
    }),
  ],
});

export default junieAgentPlugin;

/**
 * Reads the launcher's model list from the ACP session handshake. Junie has no
 * machine-readable `models` subcommand, but `session/new` answers with the same
 * catalog its `/model` picker shows, as ACP config options.
 */
export async function loadJunieModels(ctx: PluginContext): Promise<AgentModelEntry[]> {
  let snapshot;
  try {
    snapshot = await readJunieAcp(ctx, { usage: false });
  } catch {
    // The launcher must still open when Junie cannot be queried (offline, not
    // signed in); Junie then starts on its own configured default model.
    return [];
  }
  if (snapshot.missing || snapshot.session?.ok !== true) {
    return [];
  }
  return parseJunieModels(snapshot.session.result);
}

/**
 * Normalizes a `session/new` result's `configOptions` into launcher entries.
 *
 * Junie's reasoning effort is a session-wide setting rather than a per-model
 * one, so the same effort list is attached to every model.
 */
export function parseJunieModels(value: unknown): AgentModelEntry[] {
  const options = asRecord(value)?.configOptions;
  const reasoning = parseReasoning(findOption(options, "effort"));
  const models: AgentModelEntry[] = [];
  for (const candidate of records(findOption(options, "model")?.options)) {
    const id = asText(candidate.value);
    if (id === null) {
      continue;
    }
    const name = asText(candidate.name) ?? id;
    models.push(reasoning.length > 0 ? { id, name, reasoning } : { id, name });
  }
  return models;
}

/** Finds one entry of a `configOptions` array by its `id`. */
function findOption(value: unknown, id: string): Record<string, unknown> | undefined {
  return records(value).find((option) => asText(option.id) === id);
}

/** Reads the selectable reasoning efforts, if Junie reported any. */
function parseReasoning(
  option: Record<string, unknown> | undefined,
): NonNullable<AgentModelEntry["reasoning"]> {
  const entries: NonNullable<AgentModelEntry["reasoning"]> = [];
  for (const effort of records(option?.options)) {
    const id = asText(effort.value);
    if (id === null) {
      continue;
    }
    entries.push({ id, name: asText(effort.name) ?? titleCase(id) });
  }
  return entries;
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

function titleCase(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
