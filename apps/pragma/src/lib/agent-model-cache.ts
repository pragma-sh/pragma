import type { AgentModel } from "@/lib/tauri";
import { resolvePluginAgentModels } from "@/plugins/agents";

interface CachedModels {
  models: AgentModel[];
  expiresAt: number;
}

const cache = new Map<string, CachedModels>();
const inFlight = new Map<string, Promise<AgentModel[]>>();
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

/** Returns cached model metadata for an agent, if it has been resolved before. */
export function cachedAgentModels(agentId: string): AgentModel[] | undefined {
  const cached = cache.get(agentId);
  if (!cached || cached.expiresAt <= Date.now()) {
    cache.delete(agentId);
    return undefined;
  }
  return cached.models;
}

/**
 * Resolves model metadata for an agent, caching non-empty results briefly.
 *
 * Only a non-empty resolution is cached and reused on subsequent calls, so
 * repeatedly hovering an agent in the picker does not re-run the underlying —
 * and potentially process-spawning — lookup. Empty results and failures are
 * not cached: an empty list usually means the lookup ran too early (gateway
 * SDK still connecting) or the agent CLI was missing, and caching it would pin
 * "No models found" for the whole session. Cached lists expire so newly released
 * models become available without restarting. Concurrent calls are coalesced via
 * the in-flight map. Pass `force` to bypass the cache.
 */
export function refreshAgentModels(agentId: string, force = false): Promise<AgentModel[]> {
  if (!force) {
    const cached = cache.get(agentId);
    if (cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.models);
    }
    cache.delete(agentId);
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
        cache.set(agentId, { models: next, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
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
