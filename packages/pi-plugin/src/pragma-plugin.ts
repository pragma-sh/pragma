import {
  defineAgent,
  definePlugin,
  type AgentModelEntry,
  type PluginContext,
  type PluginDefinition,
} from "@pragma/plugin/catalog";
import { createTuiWatcher } from "@pragma/watcher-kit";

const PI_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
  (id) => ({ id, name: id === "xhigh" ? "Extra High" : `${id[0]?.toUpperCase()}${id.slice(1)}` }),
);

/** Pragma launcher and interjection watcher for Pi CLI. */
export const piAgentPlugin: PluginDefinition = definePlugin({
  name: "Pi",
  description: "Launch Pi CLI from Pragma.",
  // Interjection-only watcher (no decision/question keystrokes). Session-exit
  // clearing is owned entirely by the Pi extension: it reports `cleared` on
  // `session_shutdown` and again up front on the next session load, so a hard
  // process exit that skips `session_shutdown` is reconciled when Pi next opens
  // in the tab. A watcher-level `finally` `cleared` would fire a second,
  // delayed `cleared` on soft exits that can land after a quickly-relaunched
  // session's `started` and stomp it, so we mirror opencode and omit it.
  watchers: [createTuiWatcher({ agent: "pi", handleDecisions: false })],
  agents: [
    defineAgent({
      id: "pi",
      name: "Pi",
      icon: () => null,
      iconPath: "assets/pi-badge.svg",
      launch: { command: ["pi"] },
      excludeFeatures: ["questions", "commandApproval", "subagents", "usageLimits"],
      prefillDelayMs: 2000,
      prefillMode: "plain",
      prefillSubmit: "\r",
      models: async (ctx) =>
        parsePiModels(
          await execFirst(
            ctx,
            "pi --list-models 2>/dev/null || \"${SHELL:-/bin/sh}\" -lc 'pi --list-models' 2>/dev/null",
          ),
        ),
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

export default piAgentPlugin;

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

/** Parses `pi --list-models` table output into launcher model entries. */
export function parsePiModels(output: string): AgentModelEntry[] {
  return output
    .split("\n")
    .map(parsePiModelLine)
    .filter((entry): entry is AgentModelEntry => entry !== null);
}
