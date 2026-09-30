import {
  defineAgent,
  definePlugin,
  slashCommandProvider,
  type AgentFeature,
  type AgentModelEntry,
  type MarkdownSource,
  type PluginContext,
  type PluginDefinition,
  type UsageLimitProviderDefinition,
} from "@pragma-sh/plugin/catalog";
import { createTuiWatcher } from "@pragma-sh/watcher-kit";

const KITTY_ENTER = "\x1b[13u";
const KITTY_ALT_ENTER = "\x1b[13;3u";
const CLEAR_INPUT = "\x15";
const PI_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
  (id) => ({ id, name: id === "xhigh" ? "Extra High" : `${id[0]?.toUpperCase()}${id.slice(1)}` }),
);

/** Pi built-ins worth starting a session with; prompt templates and skills are discovered. */
const PI_BUILTIN_SLASH_COMMANDS = [
  { name: "compact", description: "Compact the session context", argumentHint: "[instructions]" },
  { name: "session", description: "Show session info and stats" },
];
/** Pi's prompt templates (`/<name>`) and skills (`/skill:<name>`). */
export const PI_SLASH_COMMAND_SOURCES: MarkdownSource[] = [
  { dir: ".pi/prompts", layout: "files", recursive: false },
  { dir: ".pi/skills", layout: "skills", prefix: "skill:" },
  { dir: ".agents/skills", layout: "skills", prefix: "skill:" },
  { dir: "~/.pi/agent/prompts", layout: "files", recursive: false },
  { dir: "~/.pi/agent/skills", layout: "skills", prefix: "skill:" },
  { dir: "~/.agents/skills", layout: "skills", prefix: "skill:" },
];

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
    /** Where this CLI reads prompt templates and skills. Defaults to Pi's directories. */
    slashCommandSources?: MarkdownSource[];
  };
  usageLimits?: UsageLimitProviderDefinition[];
}

/** Creates a branded Pragma launcher for a Pi-compatible coding agent. */
export function createPiPragmaPlugin(options: PiPragmaPluginOptions): PluginDefinition {
  const { agent } = options;
  const baseWatcher = createTuiWatcher({
    agent: agent.id,
    handleDecisions: false,
    // Pi queues a mid-turn follow-up with Alt+Enter. Plain Enter inserts a
    // newline while a response is streaming.
    interjectSubmitKeys: KITTY_ALT_ENTER,
  });

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
        // Pi's 100ms OSC 11 theme probe can expire before Pragma relays the
        // terminal response, leaving the late response in the composer. Clear
        // it immediately before prompt prefill.
        startupInput: [{ delayMs: 1800, data: CLEAR_INPUT }],
        prefillDelayMs: 2000,
        prefillMode: "plain",
        prefillSubmit: KITTY_ENTER,
        models: async (ctx) => parsePiModels(await execFirst(ctx, agent.modelListCommand)),
        permissionModes: [],
        slashCommands: slashCommandProvider(
          PI_BUILTIN_SLASH_COMMANDS,
          agent.slashCommandSources ?? PI_SLASH_COMMAND_SOURCES,
        ),
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
