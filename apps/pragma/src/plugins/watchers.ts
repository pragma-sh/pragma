import { gatewayConnectionInfo, startPluginWatcher } from "@/lib/tauri";

import { pluginAgentId } from "./agents";
import type { PluginRecord } from "./registry";

interface PluginWatcherRecord {
  pluginId: string;
  pluginMain: string;
  agentId: string;
  watcherAgent: string;
  config: unknown;
}

const watcherByAgent = new Map<string, PluginWatcherRecord>();
const activeWatcherSessionKeys = new Set<string>();

/** Replaces active plugin watcher contributions for the current project scope. */
export function setPluginWatchers(records: readonly PluginRecord[]): void {
  watcherByAgent.clear();
  activeWatcherSessionKeys.clear();
  for (const record of records) {
    if (record.status !== "loaded" || !record.definition || !record.mainPath) {
      continue;
    }
    for (const watcher of record.definition.watchers ?? []) {
      const agentId = pluginAgentId(record.pluginId, watcher.agent);
      watcherByAgent.set(agentId, {
        pluginId: record.pluginId,
        pluginMain: record.mainPath,
        agentId,
        watcherAgent: watcher.agent,
        // Coalesce so a config-less plugin (e.g. the built-in agents) still sends
        // a concrete JSON value; the Rust request requires one.
        config: record.config ?? {},
      });
    }
  }
}

/** Starts a host-side watcher for an agent session when one is registered. */
export async function startWatcherForAgentSession(params: {
  agentId: string;
  sessionId: string;
  tabId: string;
  worktreeId: string;
}): Promise<void> {
  const watcher = watcherByAgent.get(params.agentId);
  if (!watcher) {
    return;
  }
  const sessionKey = watcherSessionKey(params);
  if (activeWatcherSessionKeys.has(sessionKey)) {
    return;
  }
  activeWatcherSessionKeys.add(sessionKey);
  const gateway = await gatewayConnectionInfo();
  try {
    await startPluginWatcher({
      ...watcher,
      sessionId: params.sessionId,
      tabId: params.tabId,
      worktreeId: params.worktreeId,
      gatewayUrl: gateway.baseUrl,
      gatewayToken: gateway.token,
    });
  } catch (error) {
    activeWatcherSessionKeys.delete(sessionKey);
    throw error;
  }
}

function watcherSessionKey(params: {
  agentId: string;
  sessionId: string;
  tabId: string;
  worktreeId: string;
}): string {
  return [params.agentId, params.sessionId, params.tabId, params.worktreeId].join("\u0000");
}
