import { resolveAccountProviders, type UsageLimitsResult } from "@pragma-sh/plugin/catalog";
import type { PragmaClient } from "@pragma-sh/sdk";

import { accountLaunch, loadAccountUsage, withAccountEnv } from "./accounts";
import type { ResolvedPlugin } from "./catalog";

/** One loaded usage-limit provider and its current result. */
export interface ResolvedUsageLimits {
  pluginId: string;
  providerId: string;
  title: string;
  result: UsageLimitsResult;
}

/**
 * Loads each account provider's usage for its harness's own default login.
 * Backs the `usageLimits` sidecar command `pragma-cli agent verify` probes;
 * per-account usage goes through the `accounts` command instead.
 */
export async function loadUsageLimits(
  plugins: ResolvedPlugin[],
  sdk: PragmaClient,
  root: string | undefined,
  pluginId?: string,
): Promise<ResolvedUsageLimits[]> {
  const loads = plugins
    .filter((plugin) => !pluginId || plugin.pluginId === pluginId)
    .flatMap((plugin) =>
      resolveAccountProviders(plugin.definition)
        .filter((provider) => provider.usageLimits)
        .map(async (provider) => {
          const env = accountLaunch(provider, null).env;
          const result = await loadAccountUsage(provider, {
            pluginId: plugin.pluginId,
            pluginDir: plugin.dir,
            config: plugin.config,
            project: root ? { id: root, name: root, path: root } : null,
            sdk: withAccountEnv(sdk, env),
            notify: () => {},
            account: { loginId: "default", home: null, env },
          });
          return {
            pluginId: plugin.pluginId,
            providerId: provider.id,
            title: provider.title,
            result,
          };
        }),
    );
  return Promise.all(loads);
}
