import { runtimeAgentId, type ScratchpadFile } from "@pragma/sdk";

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

/**
 * The scratchpads an agent tab is attached to — the reverse of
 * {@link attachedAgentTab}, for the chat screen's scratchpad pill.
 *
 * More than one scratchpad may name the same tab, so this returns all of them
 * in list order and leaves the "which one do we show" call to the caller.
 */
export function scratchpadsForAgentTab<T extends Pick<ScratchpadFile, "agentTabId">>(
  tabId: string,
  scratchpads: readonly T[],
): T[] {
  if (!tabId) return [];
  return scratchpads.filter((scratchpad) => scratchpad.agentTabId === tabId);
}

/** How a scratchpad row describes its attachment in a list. */
export function attachmentLabel(
  scratchpad: Pick<ScratchpadFile, "agentTabId" | "agentId">,
  agentTabs: readonly AgentTab[],
): string {
  const tab = attachedAgentTab(scratchpad, agentTabs);
  if (tab) return tab.title;
  if (scratchpad.agentId) return `${runtimeAgentId(scratchpad.agentId)} · not running`;
  return "No agent attached";
}
