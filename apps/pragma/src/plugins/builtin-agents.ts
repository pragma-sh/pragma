import {
  defineAgent,
  definePlugin,
  type AgentModelEntry,
  type PluginDefinition,
  type WatcherDefinition,
} from "@pragma/plugin";

import type { PluginRecord } from "./registry";

/**
 * `mainPath` sentinel for built-in watchers. Built-in agents have no on-disk
 * plugin bundle, so the Rust side (`plugins.rs`) resolves this to the staged
 * `@pragma/opencode-plugin` watcher module the `pragma-watch` sidecar imports.
 */
const BUILTIN_OPENCODE_WATCHER_MAIN = "pragma-builtin:opencode-watcher";

/**
 * Advertises that a built-in agent has a host-side watcher so the app starts one
 * on launch. The executable `watch` runs in the `pragma-watch` sidecar (loaded
 * from {@link BUILTIN_OPENCODE_WATCHER_MAIN}, the shared built-in watcher
 * bundle); these app-side stubs are never invoked and only carry the agent id
 * used to key the watcher.
 *
 * - **opencode** has no decision-returning plugin hook, so command approval goes
 *   the watcher route (its plugin reports the command; the watcher answers via
 *   `sendKeys`) and the watcher also delivers interjections.
 * - **Claude Code / Cursor** answer approvals through a blocking `await-decision`
 *   hook, so their watchers exist only to deliver interjections (`AgentInput`).
 */
const builtinAgentWatcher = (agent: string): WatcherDefinition => ({ agent, watch: () => {} });

const claudeCodeIconPath = new URL(
  "../../../../packages/claude-code-plugin/assets/claude-code.svg",
  import.meta.url,
).href;
const cursorIconPath = new URL(
  "../../../../packages/cursor-plugin/assets/cursor.svg",
  import.meta.url,
).href;
const opencodeIconPath = new URL(
  "../../../../packages/opencode-plugin/assets/opencode.svg",
  import.meta.url,
).href;

const reasoningFull = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra High" },
  { id: "max", name: "Max" },
];

const reasoningStandard = reasoningFull.slice(0, 3);
const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

const builtinAgentsPlugin: PluginDefinition = definePlugin({
  name: "Pragma Built-in Agents",
  description: "Built-in agent launchers for Claude Code, OpenCode, and Cursor Agent.",
  agents: [
    defineAgent({
      id: "claude-code",
      name: "Claude Code",
      icon: () => null,
      iconPath: claudeCodeIconPath,
      launch: { command: ["claude", "--permission-mode", "auto"] },
      models: [
        { id: "sonnet", name: "Sonnet", reasoning: reasoningFull },
        { id: "opus", name: "Opus", reasoning: reasoningStandard },
        { id: "fable", name: "Fable", reasoning: reasoningFull },
        { id: "haiku", name: "Haiku", reasoning: reasoningStandard },
      ],
      permissionModes: [],
      args: modelReasoningArgs("--model", "--effort"),
    }),
    defineAgent({
      id: "opencode",
      name: "OpenCode",
      icon: () => null,
      iconPath: opencodeIconPath,
      launch: { command: ["opencode"] },
      prefillDelayMs: 6000,
      models: async (ctx) =>
        parseOpenCodeModels(
          await execFirst(
            ctx,
            "opencode models --json 2>/dev/null || opencode models --verbose 2>/dev/null || opencode models 2>/dev/null",
          ),
        ),
      permissionModes: [],
      args: modelReasoningArgs("--model"),
    }),
    defineAgent({
      id: "cursor",
      name: "Cursor Agent",
      icon: () => null,
      iconPath: cursorIconPath,
      launch: { command: ["agent", "--force", "--approve-mcps"] },
      startupInput: [{ delayMs: 5000, data: "a" }],
      prefillDelayMs: 14000,
      prefillMode: "plain",
      prefillSubmit: "\r",
      models: async (ctx) => parseCursorModels(await execFirst(ctx, "agent models 2>/dev/null")),
      permissionModes: [],
      args: {
        model: (modelId) => ["--model", modelId],
        reasoning: () => [],
        modelReasoning: (modelId, reasoningId) => ["--model", `${modelId}[effort=${reasoningId}]`],
        permissionMode: () => [],
      },
    }),
  ],
  watchers: [
    builtinAgentWatcher("opencode"),
    builtinAgentWatcher("claude-code"),
    builtinAgentWatcher("cursor"),
  ],
});

export const builtinAgentRecords: PluginRecord[] = [
  {
    pluginId: "pragma.builtin-agents",
    version: "0.0.0",
    scope: "builtin",
    status: "loaded",
    config: undefined,
    mainPath: BUILTIN_OPENCODE_WATCHER_MAIN,
    definition: builtinAgentsPlugin,
  },
];

function modelReasoningArgs(modelFlag: string, reasoningFlag?: string) {
  return {
    model: (modelId: string) => [modelFlag, modelId],
    reasoning: (reasoningId: string) => (reasoningFlag ? [reasoningFlag, reasoningId] : []),
    permissionMode: () => [],
  };
}

async function execFirst(
  ctx: {
    sdk: {
      exec: {
        run: (request: { cwd: string; commands: string[] }) => Promise<{ stdout: string }[]>;
      };
    };
    project: { path: string } | null;
  },
  command: string,
): Promise<string> {
  const cwd = ctx.project?.path ?? "/tmp";
  const [result] = await ctx.sdk.exec.run({ cwd, commands: [command] });
  return result?.stdout ?? "";
}

function parseOpenCodeModels(output: string): AgentModelEntry[] {
  const jsonModels = parseJsonModels(output);
  if (jsonModels.length > 0) {
    return jsonModels;
  }
  return output
    .replaceAll(ansiEscapePattern, "")
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^│|│$/g, "")
        .trim(),
    )
    .flatMap((line) => {
      if (
        !line ||
        /^(model|provider|tip|usage)/i.test(line) ||
        /^[─━│┃┌┐└┘├┤┬┴┼\-+]+$/.test(line)
      ) {
        return [];
      }
      const [id, name] = line.includes(" - ") ? line.split(" - ", 2) : splitWhitespaceModel(line);
      return id && name && !/\s/.test(id) ? [{ id, name: withProvider(id, name) }] : [];
    });
}

function parseCursorModels(output: string): AgentModelEntry[] {
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

function parseJsonModels(output: string): AgentModelEntry[] {
  try {
    const parsed = JSON.parse(output) as unknown;
    const models: AgentModelEntry[] = [];
    walk(parsed, models);
    return uniqueModels(models);
  } catch {
    return [];
  }
}

function walk(value: unknown, models: AgentModelEntry[]): void {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, models);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const model = modelFromRecord(value);
  if (model) {
    models.push(model);
  }
  for (const child of Object.values(value)) walk(child, models);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function modelFromRecord(record: Record<string, unknown>): AgentModelEntry | null {
  const id = stringValue(record.id) ?? stringValue(record.model);
  const name =
    stringValue(record.name) ?? stringValue(record.displayName) ?? stringValue(record.label) ?? id;
  if (!id || !name || !hasModelMetadata(record)) {
    return null;
  }
  return { id, name: withProvider(id, name, stringValue(record.provider)) };
}

function hasModelMetadata(record: Record<string, unknown>): boolean {
  return Boolean(record.provider || record.cost || record.limits || record.modalities);
}

function uniqueModels(models: AgentModelEntry[]): AgentModelEntry[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function splitWhitespaceModel(line: string): [string | undefined, string | undefined] {
  const parts = line.split(/\s+/);
  const id = parts[0];
  return id?.includes("/")
    ? [id, parts.slice(1).join(" ") || displayName(id)]
    : [undefined, undefined];
}

function displayName(id: string): string {
  return id.split("/").at(-1)?.replaceAll(/[-_]/g, " ") ?? id;
}

function withProvider(
  id: string,
  name: string,
  provider = id.includes("/") ? id.split("/", 1)[0] : "",
): string {
  return provider && !name.endsWith(`(${provider})`) ? `${name} (${provider})` : name;
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
