import {
  gatewayConnectionInfo,
  startPluginWatcher,
  type StartPluginWatcherRequest,
} from "@/lib/tauri";

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
let watcherGeneration = 0;
let lifecycleQueue = Promise.resolve();

type WatcherLifecycleRequest = StartPluginWatcherRequest & {
  operation: "start" | "stop" | "stopAll";
};

/** Replaces active plugin watcher contributions for the current project scope. */
export function setPluginWatchers(records: readonly PluginRecord[]): void {
  watcherGeneration += 1;
  void stopAllPluginWatchers().catch((error: unknown) => {
    console.error("failed to stop plugin watchers before refresh", error);
  });
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
  const generation = watcherGeneration;
  const gateway = await gatewayConnectionInfo();
  await lifecycleQueue;
  if (generation !== watcherGeneration || watcherByAgent.get(params.agentId) !== watcher) {
    return;
  }
  const request: WatcherLifecycleRequest = {
    ...watcher,
    operation: "start",
    sessionId: params.sessionId,
    tabId: params.tabId,
    worktreeId: params.worktreeId,
    gatewayUrl: gateway.baseUrl,
    gatewayToken: gateway.token,
  };
  await enqueueLifecycle(request);
}

/** Stops watcher process associated with one terminal session. */
export async function stopPluginWatchersForSession(params: {
  sessionId: string;
  tabId: string;
  worktreeId: string;
}): Promise<void> {
  const request: WatcherLifecycleRequest = {
    operation: "stop",
    pluginId: "",
    pluginMain: "",
    agentId: "",
    watcherAgent: "",
    config: {},
    sessionId: params.sessionId,
    tabId: params.tabId,
    worktreeId: params.worktreeId,
    gatewayUrl: "",
    gatewayToken: "",
  };
  await enqueueLifecycle(request);
}

/** Stops every watcher process before plugin contributions are replaced. */
export async function stopAllPluginWatchers(): Promise<void> {
  const request: WatcherLifecycleRequest = {
    operation: "stopAll",
    pluginId: "",
    pluginMain: "",
    agentId: "",
    watcherAgent: "",
    config: {},
    sessionId: "",
    tabId: "",
    worktreeId: "",
    gatewayUrl: "",
    gatewayToken: "",
  };
  await enqueueLifecycle(request);
}

function enqueueLifecycle(request: WatcherLifecycleRequest): Promise<void> {
  const operation = lifecycleQueue.catch(() => undefined).then(() => startPluginWatcher(request));
  lifecycleQueue = operation.catch(() => undefined);
  return operation;
}
