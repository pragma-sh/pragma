import type { Fanout, FanoutMember } from "@pragma-sh/constants";
import { memberLabel } from "@pragma-sh/fanout-view";

import type { AgentStatus } from "./types";

/**
 * An attempt's status as the shared status dot understands it: working is
 * `running`, blocked is `attention`, finished (or picked) is `done`. Failed,
 * cancelled, and interrupted attempts show no dot — their row says why in words.
 */
export function memberDotStatus(member: FanoutMember): AgentStatus | null {
  switch (member.status) {
    case "pending":
    case "provisioning":
    case "running":
      return "running";
    case "attention":
      return "attention";
    case "done":
    case "selected":
      return "done";
    default:
      return null;
  }
}

/**
 * A fanout's rollup, by the same precedence the worktree dots use: any attempt
 * needing input wins, then any still working, then done once every live
 * attempt is.
 */
export function fanoutDotStatus(fanout: Fanout): AgentStatus | null {
  const statuses = new Set(fanout.members.map(memberDotStatus));
  if (statuses.has("attention")) return "attention";
  if (statuses.has("running")) return "running";
  return statuses.has("done") ? "done" : null;
}

/**
 * How a terminal fanout ended, in one sentence — for the compare screen shown
 * after a completed, cancelled, or failed fanout releases its parent. A pick
 * names its winner; one that stopped without one names the host's failure.
 */
export function fanoutOutcome(fanout: Fanout): string {
  if (fanout.status === "cancelled") {
    return "This fanout was cancelled. Its attempt worktrees were kept.";
  }
  return pickedOutcome(fanout) ?? "This fanout failed.";
}

function pickedOutcome(fanout: Fanout): string | null {
  const winner = fanout.members.find((member) => member.id === fanout.winningMemberId);
  if (!winner) return fanout.failure?.message ?? null;
  return `${memberLabel(winner)} was picked and merged.`;
}

/** The fields `attemptScratchpads` orders by. */
interface AttemptScratchpad {
  agentTabId: string | null;
  createdAt: number;
}

/**
 * An attempt's scratchpads, the one to show first leading: one attached to the
 * attempt's own session wins, then the newest. The attempt worktree can also
 * hold scratchpads it inherited from the base commit, so attachment beats age.
 */
export function attemptScratchpads<T extends AttemptScratchpad>(
  scratchpads: readonly T[],
  tabId: string | null,
): T[] {
  const own = (scratchpad: T) => (tabId !== null && scratchpad.agentTabId === tabId ? 1 : 0);
  // oxlint-disable-next-line unicorn/no-array-sort -- Hermes has no Array#toSorted; sorting a copy is equivalent.
  return [...scratchpads].sort((a, b) => own(b) - own(a) || b.createdAt - a.createdAt);
}
