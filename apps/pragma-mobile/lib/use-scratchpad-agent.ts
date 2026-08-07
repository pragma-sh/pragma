import type { PragmaClient, ScratchpadFile } from "@pragma/sdk";
import { useCallback, useRef, useState } from "react";
import { Alert } from "react-native";

import { useConnection } from "./connection-context";
import { useAgentTabs } from "./data/data-context";
import { attachedAgentTab } from "./scratchpad-agent";
import type { AgentTab } from "./types";
import { errorText } from "./utils";

/** The scratchpad's agent attachment: which tab it prompts, and how to change it. */
export interface ScratchpadAgentSession {
  /** Whether the attach drawer is showing. */
  attachOpen: boolean;
  /** The attached tab, or null when nothing is attached or that tab is gone. */
  attachedTab: AgentTab | null;
  /** Agent tabs this worktree currently has. */
  agentTabs: AgentTab[];
  /** Opens the drawer and resolves once the user attaches or dismisses it. */
  requestAttachment: () => Promise<boolean>;
  /** Closes the drawer, releasing whatever was waiting on it. */
  closeDrawer: (attached: boolean) => void;
  /** Records the picked tab in the file's frontmatter, on the host. */
  attach: (tab: AgentTab) => Promise<void>;
  /** Sends text to the attached agent, raising the drawer first if needed. */
  promptAgent: (text: string) => Promise<"sent" | "missing-agent">;
}

/**
 * Owns a scratchpad's agent attachment, mirroring the desktop's
 * `use-scratchpad-agent`: the attachment lives in the file's frontmatter, so
 * changing it is a host write, and any action that needs an agent raises the
 * drawer rather than failing silently.
 */
export function useScratchpadAgent(
  scratchpad: ScratchpadFile,
  worktreeId: string,
  root: string | undefined,
  onAttached: () => void,
): ScratchpadAgentSession {
  const { client } = useConnection();
  const agentTabs = useAgentTabs(worktreeId);
  const [attachOpen, setAttachOpen] = useState(false);
  /** Resolves once the drawer closes, so a blocked action can continue. */
  const resolver = useRef<((attached: boolean) => void) | null>(null);
  /** The tab the drawer just picked, known before the file reload lands. */
  const pickedTabId = useRef<string | null>(null);

  const closeDrawer = useCallback((attached: boolean) => {
    setAttachOpen(false);
    resolver.current?.(attached);
    resolver.current = null;
  }, []);

  const requestAttachment = useCallback((): Promise<boolean> => {
    setAttachOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current?.(false);
      resolver.current = resolve;
    });
  }, []);

  const attach = useCallback(
    async (tab: AgentTab): Promise<void> => {
      if (!client || !root) return;
      pickedTabId.current = tab.id;
      try {
        await client.scratchpads.attachAgent({
          root,
          filePath: scratchpad.filePath,
          tabId: tab.id,
          agentId: tab.agent,
          contents: scratchpad.contents,
        });
        onAttached();
        closeDrawer(true);
      } catch (cause) {
        closeDrawer(false);
        Alert.alert("Couldn't attach agent", errorText(cause));
      }
    },
    [client, closeDrawer, onAttached, root, scratchpad],
  );

  const promptAgent = useCallback(
    async (text: string): Promise<"sent" | "missing-agent"> => {
      // `resolveTarget` only proves the attachment names a tab that is still
      // open; the frontmatter on the host — re-read by `sendAttached` — is what
      // addresses the message, so a stale local copy cannot misroute it.
      if (!(await resolveTarget())) return "missing-agent";
      return sendToAttachedAgent(client, root, scratchpad.filePath, worktreeId, text);
    },
    // `resolveTarget` closes over exactly these inputs.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [agentTabs, client, requestAttachment, root, scratchpad, worktreeId],
  );

  /** The attached tab, asking for a new attachment when there is none. */
  async function resolveTarget(): Promise<AgentTab | null> {
    const attached = attachedAgentTab(scratchpad, agentTabs);
    if (attached) return attached;
    if (!(await requestAttachment())) return null;
    return agentTabs.find((tab) => tab.id === pickedTabId.current) ?? null;
  }

  return {
    attachOpen,
    attachedTab: attachedAgentTab(scratchpad, agentTabs),
    agentTabs,
    requestAttachment,
    closeDrawer,
    attach,
    promptAgent,
  };
}

/**
 * Delivers text to whatever agent the scratchpad's frontmatter names, reported
 * as a two-state result because "nothing is attached" is a UI branch (raise the
 * drawer), not a failure.
 */
async function sendToAttachedAgent(
  client: PragmaClient | null,
  root: string | undefined,
  filePath: string,
  worktreeId: string,
  text: string,
): Promise<"sent" | "missing-agent"> {
  if (!client || !root) return "missing-agent";
  const sent = await client.scratchpads.sendAttached({ root, filePath, worktreeId, text });
  return sent.delivered ? "sent" : "missing-agent";
}
