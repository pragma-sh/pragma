import type { AgentStatus, AgentTab } from "./types";

// Aggregate priority: attention wins over running, running over done. `cleared`
// and the absence of any agent both mean "no dot". Matches the desktop's
// worktree-level rollup so both clients read the same signal.
const PRIORITY: Record<AgentStatus, number> = {
  attention: 3,
  running: 2,
  done: 1,
  cleared: 0,
};

/** Roll a set of statuses up to the single most-urgent one, or null. */
export function aggregateStatus(statuses: AgentStatus[]): AgentStatus | null {
  let best: AgentStatus | null = null;
  for (const status of statuses) {
    if (status === "cleared") continue;
    if (best === null || PRIORITY[status] > PRIORITY[best]) {
      best = status;
    }
  }
  return best;
}

/** The aggregate status for a worktree from its agent tabs. */
export function statusForTabs(tabs: AgentTab[]): AgentStatus | null {
  return aggregateStatus(tabs.map((tab) => tab.status));
}
