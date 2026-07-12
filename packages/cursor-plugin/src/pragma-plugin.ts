import {
  defineAgent,
  definePlugin,
  type AgentModelEntry,
  type PluginContext,
  type PluginDefinition,
} from "@pragma/plugin/catalog";
import { createTuiWatcher } from "@pragma/watcher-kit";

/** Lets Cursor's paste-aware TUI commit interjected text before Enter. */
const INTERJECT_SUBMIT_DELAY_MS = 200;

/**
 * Pragma plugin for Cursor Agent, bundled to `dist/pragma-plugin.mjs` and
 * loaded by the pragma-plugins sidecar, the desktop webview, and the
 * `pragma-watch` sidecar alike. Approvals go through Cursor's blocking
 * `await-decision` hook, so the watcher only delivers interjections.
 */
export const cursorAgentPlugin: PluginDefinition = definePlugin({
  name: "Cursor Agent",
  description: "Launch Cursor Agent from Pragma.",
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
