import {
  defineAgent,
  definePlugin,
  defineUsageLimitProvider,
  type AgentModelEntry,
  type PluginContext,
  type PluginDefinition,
} from "@pragma/plugin/catalog";
import { createTuiWatcher } from "@pragma/watcher-kit";

import { loadCodexUsageLimits } from "./usage-limits";

export { loadCodexUsageLimits, parseCodexUsageLimits } from "./usage-limits";

const INTERJECT_SUBMIT_DELAY_MS = 200;
const baseWatcher = createTuiWatcher({
  agent: "codex",
  handleDecisions: false,
  handleQuestionAnswers: true,
  interjectSubmitDelayMs: INTERJECT_SUBMIT_DELAY_MS,
});

/** Pragma plugin for Codex CLI. */
export const codexAgentPlugin: PluginDefinition = definePlugin({
  name: "Codex",
  description: "Launch Codex CLI from Pragma.",
  usageLimits: [
    defineUsageLimitProvider({
      id: "codex",
      title: "Codex",
      dashboardUrl: "https://chatgpt.com/codex/settings/usage",
      iconPath: "assets/codex.png",
      primaryLimitId: "codex-primary",
      refreshIntervalMs: 60_000,
      load: loadCodexUsageLimits,
    }),
  ],
  watchers: [
    {
      agent: "codex",
      async watch(ctx) {
        try {
          await baseWatcher.watch(ctx);
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
      id: "codex",
      name: "Codex",
      icon: () => null,
      iconPath: "assets/codex.png",
      launch: { command: ["codex", "--enable", "default_mode_request_user_input"] },
      prefillDelayMs: 4000,
      prefillMode: "plain",
      prefillSubmit: "\r",
      models: async (ctx) => parseCodexModels(await execFirst(ctx, "codex debug models")),
      permissionModes: [
        { id: "untrusted", name: "Ask for untrusted commands" },
        { id: "on-request", name: "Ask when requested" },
        { id: "never", name: "Never ask" },
      ],
      args: {
        model: (modelId: string) => ["--model", modelId],
        reasoning: (reasoningId: string) => [
          "--config",
          `model_reasoning_effort=${JSON.stringify(reasoningId)}`,
        ],
        modelReasoning: (modelId: string, reasoningId: string) => [
          "--model",
          modelId,
          "--config",
          `model_reasoning_effort=${JSON.stringify(reasoningId)}`,
        ],
        permissionMode: (permissionModeId: string) => ["--ask-for-approval", permissionModeId],
      },
    }),
  ],
});

export default codexAgentPlugin;

async function execFirst(ctx: PluginContext, command: string): Promise<string> {
  const [result] = await ctx.sdk.exec.run({
    cwd: ctx.project?.path ?? "/tmp",
    commands: [command],
  });
  return result?.stdout ?? "";
}

/** Parses `codex debug models` output into visible launcher entries. */
export function parseCodexModels(output: string): AgentModelEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return [];
  }
  if (!isRecord(value) || !Array.isArray(value.models)) {
    return [];
  }
  const models: AgentModelEntry[] = [];
  for (const candidate of value.models) {
    if (!isRecord(candidate) || candidate.visibility !== "list") {
      continue;
    }
    const id = stringValue(candidate.slug);
    const name = stringValue(candidate.display_name);
    if (!id || !name || id === "auto") {
      continue;
    }
    const reasoning = Array.isArray(candidate.supported_reasoning_levels)
      ? candidate.supported_reasoning_levels.flatMap((level) => reasoningEntry(level))
      : [];
    models.push(reasoning.length > 0 ? { id, name, reasoning } : { id, name });
  }
  return models;
}

function reasoningEntry(value: unknown): Array<{ id: string; name: string }> {
  if (!isRecord(value)) {
    return [];
  }
  const id = stringValue(value.effort);
  if (!id) {
    return [];
  }
  return [{ id, name: id === "xhigh" ? "Extra High" : titleCase(id) }];
}

function titleCase(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
