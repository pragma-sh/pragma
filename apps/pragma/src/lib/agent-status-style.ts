import type { AgentStatus } from "@pragma-sh/constants";

/** An agent status that is shown (a `cleared` agent is simply gone). */
export type VisibleAgentStatus = Exclude<AgentStatus, "cleared">;

/**
 * Fill color per status — shared by the status dot, the sidebar progress bars,
 * and anything else that paints agent state, so they always agree:
 * running = yellow, attention = red, done = green.
 */
export const AGENT_STATUS_FILL: Record<VisibleAgentStatus, string> = {
  running: "bg-warning",
  attention: "bg-destructive",
  done: "bg-success",
};

/** Plain-text status, used when no System 1 activity is available. */
export const AGENT_STATUS_LABEL: Record<VisibleAgentStatus, string> = {
  running: "Running",
  attention: "Needs input",
  done: "Finished",
};

/** Sort rank: what needs the user most comes first. */
export const AGENT_STATUS_RANK: Record<VisibleAgentStatus, number> = {
  attention: 0,
  running: 1,
  done: 2,
};

/** Narrows a status to one that is displayed. */
export function isVisibleAgentStatus(
  status: AgentStatus | null | undefined,
): status is VisibleAgentStatus {
  return status === "running" || status === "attention" || status === "done";
}
