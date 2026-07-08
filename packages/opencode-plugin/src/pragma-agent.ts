import {
  defineAgent,
  definePlugin,
  type AgentModelEntry,
  type PluginContext,
  type PluginDefinition,
} from "@pragma/plugin";

/** Absolute filesystem path to this plugin's agent icon. */
export const opencodeIconPath: string = new URL("../assets/opencode.svg", import.meta.url).pathname;

const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** Pragma agent contribution for OpenCode, loaded by the pragma-plugins sidecar. */
export const opencodeAgentPlugin: PluginDefinition = definePlugin({
  name: "OpenCode",
  description: "Launch OpenCode from Pragma.",
  agents: [
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
      args: {
        model: (modelId: string) => ["--model", modelId],
        reasoning: () => [],
        permissionMode: () => [],
      },
    }),
  ],
});

export default opencodeAgentPlugin;

async function execFirst(ctx: PluginContext, command: string): Promise<string> {
  const cwd = ctx.project?.path ?? "/tmp";
  const [result] = await ctx.sdk.exec.run({ cwd, commands: [command] });
  return result?.stdout ?? "";
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
