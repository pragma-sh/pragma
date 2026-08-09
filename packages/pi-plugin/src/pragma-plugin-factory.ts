import {
  defineAgent,
  definePlugin,
  type AgentFeature,
  type AgentModelEntry,
  type PluginContext,
  type PluginDefinition,
  type UsageLimitProviderDefinition,
} from "@pragma/plugin/catalog";
import { createTuiWatcher } from "@pragma/watcher-kit";

const PI_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
  (id) => ({ id, name: id === "xhigh" ? "Extra High" : `${id[0]?.toUpperCase()}${id.slice(1)}` }),
);

/** Product-specific settings for one Pragma launcher backed by a Pi-compatible CLI. */
export interface PiPragmaPluginOptions {
  plugin: {
    name: string;
    description: string;
  };
  agent: {
    id: string;
    name: string;
    iconPath: string;
    command: string[];
    modelListCommand: string;
    excludeFeatures: AgentFeature[];
  };
  usageLimits?: UsageLimitProviderDefinition[];
}

/** Creates a branded Pragma launcher for a Pi-compatible coding agent. */
export function createPiPragmaPlugin(options: PiPragmaPluginOptions): PluginDefinition {
  const { agent } = options;
  const baseWatcher = createTuiWatcher({ agent: agent.id, handleDecisions: false });

  return definePlugin({
    name: options.plugin.name,
    description: options.plugin.description,
    usageLimits: options.usageLimits,
    watchers: [
      {
        agent: agent.id,
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
        id: agent.id,
        name: agent.name,
        icon: () => null,
        iconPath: agent.iconPath,
        launch: { command: agent.command },
        excludeFeatures: agent.excludeFeatures,
        prefillDelayMs: 2000,
        prefillMode: "plain",
        prefillSubmit: "\r",
        models: async (ctx) => parsePiModels(await execFirst(ctx, agent.modelListCommand)),
        permissionModes: [],
        args: {
          model: (modelId: string) => ["--model", modelId],
          reasoning: (reasoningId: string) => ["--thinking", reasoningId],
          modelReasoning: (modelId: string, reasoningId: string) => [
            "--model",
            modelId,
            "--thinking",
            reasoningId,
          ],
          permissionMode: () => [],
        },
      }),
    ],
  });
}

async function execFirst(ctx: PluginContext, command: string): Promise<string> {
  const [result] = await ctx.sdk.exec.run({
    cwd: ctx.project?.path ?? "/tmp",
    commands: [command],
  });
  return result?.stdout ?? "";
}

const YES_NO = new Set(["yes", "no"]);

function isPiModelRow(
  fields: string[],
): fields is [string, string, string, string, string, string] {
  if (fields.length !== 6 || fields.some((field) => field === "")) return false;
  const [provider, , , , thinking, images] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (provider === "provider") return false;
  return YES_NO.has(thinking) && YES_NO.has(images);
}

function parsePiModelLine(line: string): AgentModelEntry | null {
  const fields = line.trim().split(/\s+/);
  if (!isPiModelRow(fields)) return null;
  const [provider, model, , , thinking] = fields;
  const entry: AgentModelEntry = {
    id: `${provider}/${model}`,
    name: `${model} (${provider})`,
  };
  if (thinking === "yes") entry.reasoning = PI_REASONING_LEVELS;
  return entry;
}

/** Parses a Pi-compatible six-column model table into launcher entries. */
export function parsePiModels(output: string): AgentModelEntry[] {
  return output
    .split("\n")
    .map(parsePiModelLine)
    .filter((entry): entry is AgentModelEntry => entry !== null);
}
