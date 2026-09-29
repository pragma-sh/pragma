import {
  commandAndSkillDirs,
  defineAgent,
  definePlugin,
  defineUsageLimitProvider,
  slashCommandProvider,
  type AgentMode,
  type AgentModelEntry,
  type PluginContext,
  type PluginDefinition,
} from "@pragma-sh/plugin/catalog";
import { createTuiWatcher } from "@pragma-sh/watcher-kit";

import { pluginCwd } from "./cwd";
import { loadOpenCodeGoUsageLimits } from "./usage-limits";

const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** OpenCode's own primary agents, used when `opencode agent list` is unavailable. */
const DEFAULT_MODES: AgentMode[] = [
  { id: "build", name: "Build" },
  { id: "plan", name: "Plan" },
];
/** Primary agents OpenCode runs internally and never offers in its Tab cycle. */
const HIDDEN_AGENTS = new Set(["compaction", "summary", "title"]);
const BUILTIN_SLASH_COMMANDS = [
  { name: "init", description: "Create or update AGENTS.md" },
  { name: "review", description: "Review changes", argumentHint: "[commit|branch|pr]" },
];
/** Fallback when the ACP list is unavailable (OpenCode also accepts singular `command`). */
const SLASH_COMMAND_SOURCES = [
  ...commandAndSkillDirs([".opencode", "~/.config/opencode"]),
  { dir: ".opencode/command", layout: "files" as const },
  { dir: "~/.config/opencode/command", layout: "files" as const },
];

/**
 * Pragma plugin for OpenCode, bundled to `dist/pragma-plugin.mjs` and loaded by
 * the pragma-plugins sidecar, the desktop webview, and the `pragma-watch`
 * sidecar alike. OpenCode exposes no decision-returning plugin hook on the
 * current binary, so remote command approvals and question answers go the
 * watcher route (`handleDecisions: true`).
 */
export const opencodeAgentPlugin: PluginDefinition = definePlugin({
  name: "OpenCode",
  description: "Launch OpenCode from Pragma.",
  watchers: [
    createTuiWatcher({
      agent: "opencode",
      handleDecisions: true,
      questionFinalizeKeys: "\r",
    }),
  ],
  usageLimits: [
    defineUsageLimitProvider({
      id: "opencode-go",
      title: "OpenCode Go",
      dashboardUrl: "https://opencode.ai/auth",
      iconPath: "assets/opencode.svg",
      primaryLimitId: "rolling",
      load: loadOpenCodeGoUsageLimits,
    }),
  ],
  agents: [
    defineAgent({
      id: "opencode",
      name: "OpenCode",
      icon: () => null,
      iconPath: "assets/opencode.svg",
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
      modes: async (ctx) =>
        parseOpenCodeAgents(await execFirst(ctx, "opencode agent list 2>/dev/null")),
      slashCommands: slashCommandProvider(BUILTIN_SLASH_COMMANDS, SLASH_COMMAND_SOURCES, {
        acp: { command: ["opencode", "acp"] },
      }),
      args: {
        model: (modelId: string) => ["--model", modelId],
        reasoning: () => [],
        permissionMode: () => [],
        mode: (modeId: string) => ["--agent", modeId],
      },
    }),
  ],
});

export default opencodeAgentPlugin;

async function execFirst(ctx: PluginContext, command: string): Promise<string> {
  const [result] = await ctx.sdk.exec.run({ cwd: pluginCwd(ctx), commands: [command] });
  return result?.stdout ?? "";
}

/**
 * Parses `opencode agent list` (`name (mode)` header lines, each followed by
 * its permission JSON) into the primary agents Tab cycles through, with
 * `build` and `plan` first. Falls back to those two when nothing parses.
 */
export function parseOpenCodeAgents(output: string): AgentMode[] {
  const names = output
    .replaceAll(ansiEscapePattern, "")
    .split("\n")
    .flatMap((line) => {
      const match = /^(\S+) \((primary|all|subagent)\)$/.exec(line.trim());
      return match && match[2] !== "subagent" && !HIDDEN_AGENTS.has(match[1]!) ? [match[1]!] : [];
    });
  if (names.length === 0) return DEFAULT_MODES;
  const rank = (name: string) => {
    const index = DEFAULT_MODES.findIndex((mode) => mode.id === name);
    return index === -1 ? DEFAULT_MODES.length : index;
  };
  return [...new Set(names)]
    .toSorted((a, b) => rank(a) - rank(b))
    .map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }));
}

/** Parses OpenCode's `models` output (JSON or table form) into model entries. */
export function parseOpenCodeModels(output: string): AgentModelEntry[] {
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
    .flatMap(modelFromLine);
}

function modelFromLine(line: string): AgentModelEntry[] {
  if (isModelTableDecoration(line)) return [];
  const model = parseModelLine(line);
  return model ? [model] : [];
}

function parseModelLine(line: string): AgentModelEntry | null {
  const [id, name] = modelColumns(line);
  if (!id) return null;
  if (!name) return null;
  if (/\s/.test(id)) return null;
  return { id, name: withProvider(id, name) };
}

function modelColumns(line: string): [string | undefined, string | undefined] {
  if (!line.includes(" - ")) return splitWhitespaceModel(line);
  const [id, name] = line.split(" - ", 2);
  return [id, name];
}

function isModelTableDecoration(line: string): boolean {
  return !line || /^(model|provider|tip|usage)/i.test(line) || /^[─━│┃┌┐└┘├┤┬┴┼\-+]+$/.test(line);
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

// fallow-ignore-next-line complexity -- recursive JSON traversal must branch by array, record, and leaf shape.
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
  const id = firstString(record.id, record.model);
  const name = modelName(record, id);
  if (!id || !name || !hasModelMetadata(record)) {
    return null;
  }
  return { id, name: withProvider(id, name, stringValue(record.provider)) };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const string = stringValue(value);
    if (string) return string;
  }
  return undefined;
}

function modelName(record: Record<string, unknown>, id: string | undefined): string | undefined {
  return (
    stringValue(record.name) ?? stringValue(record.displayName) ?? stringValue(record.label) ?? id
  );
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

/**
 * Derives a readable name from a bare model id.
 *
 * OpenCode ids spell version dots as hyphens (`claude-opus-4-5` is Opus 4.5),
 * so a blanket hyphen-to-space rewrite silently drops the dot from the version
 * number. A hyphen sitting between two digits becomes `.`; every other
 * separator becomes a space.
 */
function displayName(id: string): string {
  const bare = id.split("/").at(-1);
  if (!bare) {
    return id;
  }
  return bare.replaceAll(/(?<=\d)-(?=\d)/g, ".").replaceAll(/[-_]/g, " ");
}

function withProvider(
  id: string,
  name: string,
  provider = id.includes("/") ? id.split("/", 1)[0] : "",
): string {
  return provider && !name.endsWith(`(${provider})`) ? `${name} (${provider})` : name;
}
