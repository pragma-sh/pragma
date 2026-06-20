import { useSyncExternalStore } from "react";

import type { AgentReportPayload, AgentStatus } from "@pragma/constants";

type AgentMap = Map<string, AgentStatus>;
type TabMap = Map<string, AgentMap>;
type WorktreeMap = Map<string, TabMap>;

const listeners = new Set<() => void>();
const statuses: WorktreeMap = new Map();

const priority: Record<AgentStatus, number> = {
  cleared: 0,
  done: 1,
  running: 2,
  attention: 3,
};

/**
 * Stores one daemon agent report and returns the previous status for that agent.
 *
 * A `cleared` report is a removal signal (the agent process exited): it deletes
 * the agent's entry entirely instead of leaving a stored status, so no indicator
 * lingers — distinct from `done`, which keeps a green "finished, go look" dot.
 */
export function applyAgentReport(payload: AgentReportPayload): AgentStatus | null {
  if (payload.status === "cleared") {
    return removeAgent(payload.worktreeId, payload.tabId, payload.agent);
  }
  let tabs = statuses.get(payload.worktreeId);
  if (!tabs) {
    tabs = new Map();
    statuses.set(payload.worktreeId, tabs);
  }
  let agents = tabs.get(payload.tabId);
  if (!agents) {
    agents = new Map();
    tabs.set(payload.tabId, agents);
  }
  const previous = agents.get(payload.agent) ?? null;
  agents.set(payload.agent, payload.status);
  emit();
  return previous;
}

/** Drops a single agent's entry, pruning empty tab/worktree maps. Returns its previous status. */
function removeAgent(worktreeId: string, tabId: string, agent: string): AgentStatus | null {
  const tabs = statuses.get(worktreeId);
  const agents = tabs?.get(tabId);
  const previous = agents?.get(agent) ?? null;
  if (agents?.delete(agent)) {
    if (agents.size === 0) {
      tabs?.delete(tabId);
    }
    if (tabs && tabs.size === 0) {
      statuses.delete(worktreeId);
    }
    emit();
  }
  return previous;
}

/**
 * Clears only resolved (`done`/green) indicators for a tab once the user views
 * it. `running` (yellow) and `attention` (red) persist through a focus so the
 * indicator only drops once the agent is actually finished and seen.
 */
export function clearDoneStatusForTab(tabId: string): void {
  let changed = false;
  for (const [worktreeId, tabs] of statuses) {
    const agents = tabs.get(tabId);
    if (agents) {
      for (const [agentId, status] of agents) {
        if (status === "done") {
          agents.delete(agentId);
          changed = true;
        }
      }
      if (agents.size === 0) {
        tabs.delete(tabId);
      }
    }
    if (tabs.size === 0) {
      statuses.delete(worktreeId);
    }
  }
  if (changed) {
    emit();
  }
}

/** Drops every agent status for a tab once it is closed, so no stale indicator lingers. */
export function removeAgentStatusForTab(tabId: string): void {
  let changed = false;
  for (const [worktreeId, tabs] of statuses) {
    if (tabs.delete(tabId)) {
      changed = true;
    }
    if (tabs.size === 0) {
      statuses.delete(worktreeId);
    }
  }
  if (changed) {
    emit();
  }
}

/** Clears every cached agent status so the UI can mirror a fresh daemon snapshot. */
export function clearAllAgentStatuses(): void {
  if (statuses.size === 0) {
    return;
  }
  statuses.clear();
  emit();
}

/**
 * Returns every stored agent entry for a tab. Used to latch the statuses the
 * user is now seeing as "alerted" when a tab comes on screen, so a later daemon
 * snapshot replay doesn't re-fire a notification the user already looked at.
 */
export function agentStatusesForTab(
  tabId: string,
): Array<{ worktreeId: string; agent: string; status: AgentStatus }> {
  const entries: Array<{ worktreeId: string; agent: string; status: AgentStatus }> = [];
  for (const [worktreeId, tabs] of statuses) {
    const agents = tabs.get(tabId);
    if (!agents) {
      continue;
    }
    for (const [agent, status] of agents) {
      entries.push({ worktreeId, agent, status });
    }
  }
  return entries;
}

/** Returns the highest-priority agent status for a tab. */
export function tabStatus(tabId: string | null): AgentStatus | null {
  if (!tabId) {
    return null;
  }
  for (const tabs of statuses.values()) {
    const agents = tabs.get(tabId);
    if (agents) {
      return aggregate(agents.values());
    }
  }
  return null;
}

/** Returns the highest-priority agent status for all tabs in a worktree. */
export function worktreeStatus(worktreeId: string | null): AgentStatus | null {
  if (!worktreeId) {
    return null;
  }
  const tabs = statuses.get(worktreeId);
  if (!tabs) {
    return null;
  }
  const values: AgentStatus[] = [];
  for (const agents of tabs.values()) {
    values.push(...agents.values());
  }
  return aggregate(values);
}

/** React hook for a tab's aggregate agent status. */
export function useTabAgentStatus(tabId: string | null): AgentStatus | null {
  return useSyncExternalStore(
    subscribe,
    () => tabStatus(tabId),
    () => null,
  );
}

/** React hook for a worktree's aggregate agent status. */
export function useWorktreeAgentStatus(worktreeId: string | null): AgentStatus | null {
  return useSyncExternalStore(
    subscribe,
    () => worktreeStatus(worktreeId),
    () => null,
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function aggregate(values: Iterable<AgentStatus>): AgentStatus | null {
  let best: AgentStatus | null = null;
  for (const value of values) {
    if (!best || priority[value] > priority[best]) {
      best = value;
    }
  }
  return best;
}
