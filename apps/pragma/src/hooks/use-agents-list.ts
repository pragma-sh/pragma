import { useEffect, useState } from "react";

import { type AgentConfig, listAgents } from "@/lib/tauri";

/**
 * Loads the configured agents list, cancelling any in-flight load when the
 * `active` flag flips. Returns `[]` until the load resolves (or on failure).
 */
export function useAgentsList(active = true): AgentConfig[] {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;
    listAgents()
      .then((items) => {
        if (!cancelled) {
          setAgents(Array.isArray(items) ? items : []);
        }
        return undefined;
      })
      .catch(() => {
        if (!cancelled) {
          setAgents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return agents;
}
