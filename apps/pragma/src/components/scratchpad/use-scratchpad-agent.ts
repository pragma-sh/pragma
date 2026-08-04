import { useRef, useState, type RefObject } from "react";

import type { Tab } from "@pragma/constants";
import { toast } from "sonner";

import { attachScratchpadAgent } from "@/components/scratchpad/scratchpad-document";
import { errorMessage } from "@/lib/errors";
import { scratchpadPromptAgent } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

export interface ScratchpadAgentOptions {
  worktreeId: string;
  /** The scratchpad's current on-disk text, used to rewrite its attachment metadata. */
  currentDocRef: RefObject<string>;
  /** Applies an edited document to the tab's unsaved buffer. */
  onChange: (next: string) => void;
  save: (next: string) => Promise<void>;
  /** Re-reads the document after its metadata changed. */
  onAttached: (next: string, agentTabId: string) => void;
}

export interface ScratchpadAgent {
  /** Whether the "pick an agent tab" dialog is open. */
  attachOpen: boolean;
  /** Agent terminal tabs in this worktree, offered by the dialog. */
  agentTabs: Tab[];
  /** The tab id the scratchpad is currently attached to, read lazily by the preview frame. */
  attachedTabRef: RefObject<string | null>;
  /** Opens the dialog; resolves true once an agent is attached, false if dismissed. */
  requestAgentAttachment: () => Promise<boolean>;
  closeAttachment: (attached: boolean) => void;
  attachAgent: (agentTab: Tab) => Promise<void>;
  /** Prompts the attached agent, asking for an attachment first when there is none. */
  sendToAgent: (text: string) => Promise<boolean>;
}

/**
 * Owns the scratchpad's agent attachment: which terminal tab it talks to, the
 * dialog that picks one, and delivering prompts to it.
 */
export function useScratchpadAgent({
  worktreeId,
  currentDocRef,
  onChange,
  save,
  onAttached,
}: ScratchpadAgentOptions): ScratchpadAgent {
  const workspace = useWorkspace();
  const attachedTabRef = useRef<string | null>(null);
  const attachResolverRef = useRef<((attached: boolean) => void) | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);

  const agentTabs = workspace.tabs.filter(
    (candidate) =>
      candidate.worktreeId === worktreeId && candidate.kind === "terminal" && candidate.agentId,
  );

  const requestAgentAttachment = (): Promise<boolean> => {
    setAttachOpen(true);
    return new Promise((resolve) => {
      attachResolverRef.current?.(false);
      attachResolverRef.current = resolve;
    });
  };

  const closeAttachment = (attached: boolean): void => {
    setAttachOpen(false);
    attachResolverRef.current?.(attached);
    attachResolverRef.current = null;
  };

  const attachAgent = async (agentTab: Tab): Promise<void> => {
    if (!agentTab.agentId) return;
    const next = attachScratchpadAgent(currentDocRef.current, {
      tabId: agentTab.id,
      agentId: agentTab.agentId,
    });
    onChange(next);
    attachedTabRef.current = agentTab.id;
    onAttached(next, agentTab.id);
    await save(next);
    closeAttachment(true);
  };

  const sendToAgent = async (text: string): Promise<boolean> => {
    const target = await resolveTarget();
    if (!target) return false;
    try {
      await scratchpadPromptAgent(worktreeId, target, text);
      return true;
    } catch (cause) {
      toast.error(errorMessage(cause));
      return false;
    }
  };

  /** The attached tab, prompting for a new attachment when it is gone or unset. */
  const resolveTarget = async (): Promise<string | null> => {
    const target = attachedTabRef.current;
    const exists = workspace.tabs.some(
      (candidate) =>
        candidate.id === target && candidate.worktreeId === worktreeId && candidate.agentId,
    );
    if (target && exists) return target;
    attachedTabRef.current = null;
    if (!(await requestAgentAttachment())) return null;
    return attachedTabRef.current;
  };

  return {
    attachOpen,
    agentTabs,
    attachedTabRef,
    requestAgentAttachment,
    closeAttachment,
    attachAgent,
    sendToAgent,
  };
}
