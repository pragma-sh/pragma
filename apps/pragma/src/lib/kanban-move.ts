import type { KanbanPromptStatus } from "@pragma/constants";

/**
 * What a card drag between columns resolves to. The board mirrors the per-card
 * button actions, so only forward, single-step transitions are honored:
 * - `start`: draft → inProgress (creates the worktree and launches the agent)
 * - `review`: inProgress → reviewNeeded (mark the run as awaiting review)
 * - `complete`: reviewNeeded → completed (open the completion dialog)
 * - `noop`: dropped back in the same column (no persisted order to change)
 * - `blocked`: any other drop, which snaps the card back
 */
export type KanbanMoveOutcome = "start" | "review" | "complete" | "noop" | "blocked";

/** Resolves a column-to-column card drag to the transition it should trigger. */
export function routeKanbanMove(
  from: KanbanPromptStatus,
  to: KanbanPromptStatus,
): KanbanMoveOutcome {
  if (from === to) {
    return "noop";
  }
  if (from === "draft" && to === "inProgress") {
    return "start";
  }
  if (from === "inProgress" && to === "reviewNeeded") {
    return "review";
  }
  if (from === "reviewNeeded" && to === "completed") {
    return "complete";
  }
  return "blocked";
}
