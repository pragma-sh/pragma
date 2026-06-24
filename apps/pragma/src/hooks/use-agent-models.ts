import { useCallback, useState } from "react";

import { cachedAgentModels, refreshAgentModels } from "@/lib/agent-model-cache";
import type { AgentModel } from "@/lib/tauri";

/** Per-agent model metadata plus loaders, shared by the agent-launch dialogs. */
export interface AgentModelsState {
  /** Resolved models per agent id; `undefined` means a load is in flight. */
  modelsByAgent: Record<string, AgentModel[] | undefined>;
  /** Lazily loads (and caches) an agent's models, e.g. when its submenu is hovered. */
  loadModels: (agentId: string) => void;
  /** Seeds state from the session cache for any of the given agents already resolved. */
  primeFromCache: (agentIds: string[]) => void;
}

/**
 * Owns the `modelsByAgent` map and its loaders. Hovering a model submenu calls
 * `loadModels` repeatedly, so this avoids redundant state churn: once an agent's
 * models are cached it reuses the same array reference and skips the lookup
 * instead of re-running it (and re-rendering) on every hover.
 */
export function useAgentModels(): AgentModelsState {
  const [modelsByAgent, setModelsByAgent] = useState<Record<string, AgentModel[] | undefined>>({});

  const loadModels = useCallback((agentId: string) => {
    const cached = cachedAgentModels(agentId);
    if (cached) {
      // Already resolved: adopt it once, then no-op on repeat hovers.
      setModelsByAgent((current) =>
        current[agentId] === cached ? current : { ...current, [agentId]: cached },
      );
      return;
    }
    setModelsByAgent((current) =>
      agentId in current ? current : { ...current, [agentId]: undefined },
    );
    void refreshAgentModels(agentId).then((models) => {
      setModelsByAgent((current) => ({ ...current, [agentId]: models }));
      return models;
    });
  }, []);

  const primeFromCache = useCallback((agentIds: string[]) => {
    setModelsByAgent((current) => {
      let next = current;
      for (const agentId of agentIds) {
        const cached = cachedAgentModels(agentId);
        if (cached && current[agentId] !== cached) {
          if (next === current) {
            next = { ...current };
          }
          next[agentId] = cached;
        }
      }
      return next;
    });
  }, []);

  return { modelsByAgent, loadModels, primeFromCache };
}
