import type { AgentConfig } from "@/lib/tauri";
import { usePluginAgents } from "@/plugins/agents";

/**
 * Loads the configured agents list, cancelling any in-flight load when the
 * `active` flag flips. Returns `[]` until the load resolves (or on failure).
 */
export function useAgentsList(active = true): AgentConfig[] {
  const pluginAgents = usePluginAgents();
  return active ? pluginAgents : [];
}
