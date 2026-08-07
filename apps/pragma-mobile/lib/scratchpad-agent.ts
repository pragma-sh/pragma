import type { ScratchpadFile } from "@pragma/sdk";

import type { AgentTab } from "./types";

/**
 * The agent tab a scratchpad prompts: the one its frontmatter names, but only
 * while that tab is still open in this worktree.
 *
 * A closed tab is the common case — a scratchpad outlives the session that
 * wrote it — and prompting a dead tab silently drops the message, so an absent
 * result means "ask the user to attach one", not "error".
 */
export function attachedAgentTab(
  scratchpad: Pick<ScratchpadFile, "agentTabId">,
  agentTabs: readonly AgentTab[],
): AgentTab | null {
  if (!scratchpad.agentTabId) return null;
  return agentTabs.find((tab) => tab.id === scratchpad.agentTabId) ?? null;
}

/** How a scratchpad row describes its attachment in a list. */
export function attachmentLabel(
  scratchpad: Pick<ScratchpadFile, "agentTabId" | "agentId">,
  agentTabs: readonly AgentTab[],
): string {
  const tab = attachedAgentTab(scratchpad, agentTabs);
  if (tab) return tab.title;
  if (scratchpad.agentId) return `${lastSegment(scratchpad.agentId)} · not running`;
  return "No agent attached";
}

/**
 * The runtime agent id a report must carry.
 *
 * Frontmatter stores the catalog id (`plugin.agent`), while the agent event
 * stream is keyed by the plugin's own runtime id — its last segment. Sending
 * the qualified id makes the message invisible to the running agent.
 */
export function lastSegment(agentId: string): string {
  return agentId.split(".").at(-1) ?? agentId;
}
