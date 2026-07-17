import type { PluginContext, UsageLimitsResult } from "@pragma/plugin";
import type { PragmaClient } from "@pragma/sdk";

import type { ResolvedPlugin } from "./catalog";

/** One loaded usage-limit provider and its current result. */
export interface ResolvedUsageLimits {
  pluginId: string;
  providerId: string;
  title: string;
  result: UsageLimitsResult;
}

/** Loads usage-limit providers from matching resolved plugins. */
export async function loadUsageLimits(
  plugins: ResolvedPlugin[],
  sdk: PragmaClient,
  root: string | undefined,
  pluginId?: string,
): Promise<ResolvedUsageLimits[]> {
  const loads = plugins
    .filter((plugin) => !pluginId || plugin.pluginId === pluginId)
    .flatMap((plugin) => {
      const ctx = contextFor(plugin, sdk, root);
      return (plugin.definition.usageLimits ?? []).map((provider) => ({
        pluginId: plugin.pluginId,
        providerId: provider.id,
        title: provider.title,
        load: provider.load(ctx),
      }));
    });
  const results = await Promise.allSettled(loads.map((load) => load.load));
  return results.flatMap((result, index) => {
    const load = loads[index];
    if (!load) {
      return [];
    }
    return [
      {
        pluginId: load.pluginId,
        providerId: load.providerId,
        title: load.title,
        result:
          result.status === "fulfilled"
            ? result.value
            : unavailableResult(load.title, result.reason),
      },
    ];
  });
}

function unavailableResult(title: string, reason: unknown): UsageLimitsResult {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return {
    status: "unavailable",
    reason: "error",
    message: detail || `${title} usage limits could not be loaded.`,
  };
}

function contextFor(
  plugin: ResolvedPlugin,
  sdk: PragmaClient,
  root: string | undefined,
): PluginContext {
  return {
    pluginId: plugin.pluginId,
    pluginDir: plugin.dir,
    config: plugin.config,
    project: root ? { id: root, name: root, path: root } : null,
    sdk,
    notify: () => {},
  };
}
