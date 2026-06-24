import { type AgentModel, resolveAgentModels } from "@/lib/tauri";

const cache = new Map<string, AgentModel[]>();
const inFlight = new Map<string, Promise<AgentModel[]>>();

/** Returns cached model metadata for an agent, if it has been resolved before. */
export function cachedAgentModels(agentId: string): AgentModel[] | undefined {
  return cache.get(agentId);
}

/**
 * Resolves model metadata for an agent, caching the result for the session.
 *
 * A successful resolution (including a legitimately empty list) is cached and
 * reused on every subsequent call, so repeatedly hovering an agent in the picker
 * does not re-run the underlying — and potentially process-spawning — lookup.
 * Failures are not cached, leaving the next call free to retry. Concurrent calls
 * are coalesced via the in-flight map. Pass `force` to bypass the cache.
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
  const request = resolveAgentModels(agentId)
    .then((models) => {
      const next = Array.isArray(models) ? models : [];
      cache.set(agentId, next);
      return next;
    })
    .catch(() => [] as AgentModel[])
    .finally(() => {
      inFlight.delete(agentId);
    });
  inFlight.set(agentId, request);
  return request;
}
