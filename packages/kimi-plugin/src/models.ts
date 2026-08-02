import type { AgentModelEntry, PluginContext } from "@pragma/plugin/catalog";

const KIMI_MODELS_COMMAND = "kimi provider list --json";
const KIMI_DEFAULT_MODEL_COMMAND = "kimi provider list";

interface KimiConfigModel {
  provider: string;
  model: string;
  displayName?: string;
}

/** Reads Kimi's model aliases through its supported host CLI. */
export async function loadKimiModels(ctx: PluginContext): Promise<AgentModelEntry[]> {
  try {
    const results = await ctx.sdk.exec.run({
      cwd: ctx.project?.path ?? "/tmp",
      commands: [KIMI_MODELS_COMMAND, KIMI_DEFAULT_MODEL_COMMAND],
    });
    return kimiModelsFromConfig(
      parseKimiProviderModels(results[0]?.stdout ?? ""),
      parseKimiDefaultModel(results[1]?.stdout ?? ""),
    );
  } catch {
    return [];
  }
}

/**
 * Maps Kimi's config record to launcher model entries, preferring the
 * configured default and otherwise preserving declaration order.
 */
export function kimiModelsFromConfig(
  config: Record<string, KimiConfigModel>,
  defaultModel?: string,
): AgentModelEntry[] {
  const entries = Object.entries(config).map(([id, model]) => ({
    id,
    name: model.displayName ?? model.model,
  }));
  const defaultIndex = entries.findIndex((entry) => entry.id === defaultModel);
  if (defaultIndex > 0) {
    const [entry] = entries.splice(defaultIndex, 1);
    if (entry !== undefined) entries.unshift(entry);
  }
  return entries;
}

/**
 * Parses `kimi provider list --json` without retaining provider credentials,
 * skipping aliases Kimi reports as disabled.
 */
export function parseKimiProviderModels(output: string): Record<string, KimiConfigModel> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return {};
  }
  const models = recordValue(recordValue(value)?.models);
  if (models === undefined) return {};

  const parsed: Record<string, KimiConfigModel> = {};
  for (const [alias, candidate] of Object.entries(models)) {
    const model = recordValue(candidate);
    if (model === undefined || typeof model.model !== "string" || model.model.length === 0) {
      continue;
    }
    // A disabled alias is rejected by Kimi at launch, so it must never reach the picker.
    if (model.disabled === true) continue;
    parsed[alias] = {
      provider: typeof model.provider === "string" ? model.provider : "",
      model: model.model,
      ...(typeof model.displayName === "string" ? { displayName: model.displayName } : {}),
    };
  }
  return parsed;
}

/** Reads the optional default alias from human-readable `kimi provider list`. */
export function parseKimiDefaultModel(output: string): string | undefined {
  const match = /^Default model:\s*(.+)$/m.exec(output);
  return match?.[1]?.trim() || undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
