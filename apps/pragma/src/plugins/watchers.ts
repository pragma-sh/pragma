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

/** Replaces active plugin watcher contributions for the current project scope. */
export function setPluginWatchers(records: readonly PluginRecord[]): void {
  watcherByAgent.clear();
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
        config: record.config,
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
  const gateway = await gatewayConnectionInfo();
  await startPluginWatcher({
    ...watcher,
    sessionId: params.sessionId,
    tabId: params.tabId,
    worktreeId: params.worktreeId,
    gatewayUrl: gateway.baseUrl,
    gatewayToken: gateway.token,
  });
}
