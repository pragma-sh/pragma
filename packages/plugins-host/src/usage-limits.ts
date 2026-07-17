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
      return (plugin.definition.usageLimits ?? []).map(async (provider) => ({
        pluginId: plugin.pluginId,
        providerId: provider.id,
        title: provider.title,
        result: await provider.load(ctx),
      }));
    });
  return Promise.all(loads);
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
