import { useEffect, useState } from "react";

import type { LockedPlugin } from "@pragma-sh/plugin-registry";

import { loadOfficialPluginLock } from "@/lib/plugin-registry";
import { availablePluginBinaries } from "@/lib/tauri";

/**
 * The official agent-plugin packages whose agent CLI is actually installed on
 * this machine — the set worth recommending during onboarding.
 *
 * `loaded` distinguishes "no recommendations" from "not looked yet", so a caller
 * does not flash an empty state while the binary probe is in flight.
 */
export function useRecommendedAgentPlugins(): { loaded: boolean; recommended: LockedPlugin[] } {
  const [recommended, setRecommended] = useState<LockedPlugin[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // The published lock, not the bundled one: a shipped build must recommend current
    // releases. `loadOfficialPluginLock` falls back to the bundled copy offline.
    void loadOfficialPluginLock()
      .then(async (lock) => {
        const candidates = lock.filter(
          (plugin) =>
            plugin.manifest.categories?.includes("agent-plugin") && plugin.manifest.agentBinary,
        );
        const binaries = candidates.flatMap((plugin) => plugin.manifest.agentBinary ?? []);
        const available = await availablePluginBinaries(binaries);
        if (cancelled) return undefined;
        const installed = new Set(available);
        setRecommended(
          candidates.filter((plugin) => installed.has(plugin.manifest.agentBinary ?? "")),
        );
        return undefined;
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { loaded, recommended };
}
