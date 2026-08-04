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

/** Sort rank for a status; `cleared`/absent rank below every real status. */
export function statusRank(status: AgentStatus | null): number {
  return status && status !== "cleared" ? (PRIORITY[status] ?? -1) : -1;
}

/** Roll a set of statuses up to the single most-urgent one, or null. */
function aggregateStatus(statuses: AgentStatus[]): AgentStatus | null {
  return statuses.reduce<AgentStatus | null>(
    (best, status) => (statusRank(status) > statusRank(best) ? status : best),
    null,
  );
}

/** The aggregate status for a worktree from its agent tabs. */
export function statusForTabs(tabs: AgentTab[]): AgentStatus | null {
  return aggregateStatus(tabs.map((tab) => tab.status));
}
