import type { AgentModel } from "@/lib/tauri";
import { resolvePluginAgentModels } from "@/plugins/agents";

const cache = new Map<string, AgentModel[]>();
const inFlight = new Map<string, Promise<AgentModel[]>>();

/** Returns cached model metadata for an agent, if it has been resolved before. */
export function cachedAgentModels(agentId: string): AgentModel[] | undefined {
  return cache.get(agentId);
}

/**
 * Resolves model metadata for an agent, caching the result for the session.
 *
 * Only a non-empty resolution is cached and reused on subsequent calls, so
 * repeatedly hovering an agent in the picker does not re-run the underlying —
 * and potentially process-spawning — lookup. Empty results and failures are
 * not cached: an empty list usually means the lookup ran too early (gateway
 * SDK still connecting) or the agent CLI was missing, and caching it would pin
 * "No models found" for the whole session. Concurrent calls are coalesced via
 * the in-flight map. Pass `force` to bypass the cache.
 */
export function refreshAgentModels(agentId: string, force = false): Promise<AgentModel[]> {
  if (!force) {
    const cached = cache.get(agentId);
    if (cached) {
      return Promise.resolve(cached);
    }
  }
  const existing = inFlight.get(agentId);
  if (existing) {
    return existing;
  }
  const request = resolvePluginAgentModels(agentId)
    .then((pluginModels) => pluginModels ?? [])
    .then((models) => {
      const next = Array.isArray(models) ? models : [];
      if (next.length > 0) {
        cache.set(agentId, next);
      }
      return next;
    })
    .catch(() => [] as AgentModel[])
    .finally(() => {
      inFlight.delete(agentId);
    });
  inFlight.set(agentId, request);
  return request;
}
