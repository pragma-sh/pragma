import { useEffect, useMemo, useRef, useState } from "react";

import { GitBranch } from "lucide-react";

import { AgentIcon } from "@/components/agents/AgentIcon";
import { MarkdownEditor } from "@/components/github/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import type { NewChatDeepLinkDetail } from "@/lib/deep-link";
import { isMacPlatform } from "@/lib/platform";
import { type AgentConfig, listAgents } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

interface NewChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Values to seed the form with when the dialog opens (e.g. from a deep link). */
  initial?: NewChatDeepLinkDetail | null;
}

/**
 * Starts a fresh agent thread: the user writes a markdown prompt, picks an agent
 * and a target worktree, then submits (⌘/Ctrl+↵ or the button). Submitting
 * switches to the chosen worktree, opens a terminal tab, launches the agent, and
 * prefills the prompt into the agent's TUI without sending it.
 */
export function NewChatDialog({ open: isOpen, onOpenChange, initial }: NewChatDialogProps) {
  const workspace = useWorkspace();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [message, setMessage] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [worktreeId, setWorktreeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitShortcut = isMacPlatform() ? "⌘↵" : "Ctrl+↵";
  useEscapeToClose(isOpen, () => onOpenChange(false));

  const worktrees = useMemo(
    () =>
      workspace.selectedProjectId
        ? (workspace.worktrees[workspace.selectedProjectId] ?? []).filter((w) => !w.hidden)
        : [],
    [workspace.selectedProjectId, workspace.worktrees],
  );
  const loadedWorktrees = useMemo(
    () => Object.values(workspace.worktrees).flat(),
    [workspace.worktrees],
  );

  // Load the configured agents whenever the dialog opens.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let cancelled = false;
    listAgents()
      .then((items) => {
        if (!cancelled) {
          setAgents(Array.isArray(items) ? items : []);
        }
        return undefined;
      })
      .catch(() => {
        if (!cancelled) {
          setAgents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Seed the form when the dialog opens, and also when a fresh deep-link payload
  // arrives while it is open. Avoid reseeding on unrelated re-renders so the
  // user's edits are not clobbered.
  const wasOpenRef = useRef(false);
  const lastInitialRef = useRef<NewChatDeepLinkDetail | null | undefined>(undefined);
  const agentManuallyChangedRef = useRef(false);
  const worktreeManuallyChangedRef = useRef(false);
  useEffect(() => {
    const opened = isOpen && !wasOpenRef.current;
    const receivedInitial = isOpen && initial !== lastInitialRef.current;
    if (opened || receivedInitial) {
      agentManuallyChangedRef.current = false;
      worktreeManuallyChangedRef.current = false;
      setMessage(initial?.message ?? "");
      setWorktreeId(initial?.worktreeId ?? workspace.selectedWorktreeId);
      setAgentId(initial?.agentId ?? null);
    }
    wasOpenRef.current = isOpen;
    lastInitialRef.current = initial;
  }, [isOpen, initial, workspace.selectedWorktreeId]);

  // Resolve the agent selection: keep a valid choice, otherwise fall back to the
  // first (default) agent — also covers a deep link naming an unknown agent id.
  useEffect(() => {
    if (!isOpen || agents.length === 0) {
      return;
    }
    const requestedAgentId = initial?.agentId ?? null;
    setAgentId((current) => {
      if (
        requestedAgentId &&
        !agentManuallyChangedRef.current &&
        agents.some((agent) => agent.id === requestedAgentId)
      ) {
        return requestedAgentId;
      }
      return current && agents.some((agent) => agent.id === current) ? current : agents[0]!.id;
    });
  }, [isOpen, initial?.agentId, agents]);

  useEffect(() => {
    const requestedWorktreeId = initial?.worktreeId;
    if (!isOpen || !requestedWorktreeId || worktreeManuallyChangedRef.current) {
      return;
    }
    if (
      worktrees.some((worktree) => worktree.id === requestedWorktreeId) ||
      loadedWorktrees.some((worktree) => worktree.id === requestedWorktreeId)
    ) {
      setWorktreeId(requestedWorktreeId);
    }
  }, [isOpen, initial?.worktreeId, loadedWorktrees, worktrees]);

  // Default to the currently selected worktree even when that selection only
  // becomes available after the dialog opened — e.g. a cold-start deep link
  // opens the dialog before the persisted selection has hydrated. Only fills an
  // empty choice, so a worktree the user (or deep link) picked is left alone.
  useEffect(() => {
    if (isOpen && !initial?.worktreeId && worktreeId === null && workspace.selectedWorktreeId) {
      setWorktreeId(workspace.selectedWorktreeId);
    }
  }, [isOpen, initial?.worktreeId, worktreeId, workspace.selectedWorktreeId]);

  if (!isOpen) {
    return null;
  }

  const requestedAgentId =
    !agentManuallyChangedRef.current &&
    initial?.agentId &&
    agents.some((agent) => agent.id === initial.agentId)
      ? initial.agentId
      : null;
  const requestedWorktreeId =
    !worktreeManuallyChangedRef.current &&
    initial?.worktreeId &&
    loadedWorktrees.some((worktree) => worktree.id === initial.worktreeId)
      ? initial.worktreeId
      : null;
  const effectiveAgentId = requestedAgentId ?? agentId;
  const effectiveWorktreeId = requestedWorktreeId ?? worktreeId;
  const selectedAgent = agents.find((agent) => agent.id === effectiveAgentId) ?? null;
  const selectedWorktree =
    worktrees.find((worktree) => worktree.id === effectiveWorktreeId) ??
    loadedWorktrees.find((worktree) => worktree.id === effectiveWorktreeId) ??
    null;
  const agentSelectValue = effectiveAgentId ?? "";
  const worktreeSelectValue = effectiveWorktreeId ?? "";
  const canSubmit = Boolean(selectedAgent && effectiveWorktreeId && message.trim());

  function handleAgentChange(nextAgentId: string) {
    setAgentId(nextAgentId);
  }

  function handleWorktreeChange(nextWorktreeId: string) {
    setWorktreeId(nextWorktreeId);
  }

  function markAgentManuallyChanged() {
    agentManuallyChangedRef.current = true;
  }

  function markWorktreeManuallyChanged() {
    worktreeManuallyChangedRef.current = true;
  }

  async function submit() {
    if (!effectiveWorktreeId || !selectedAgent) {
      return;
    }
    try {
      const tab = await workspace.startChat(effectiveWorktreeId, selectedAgent, message);
      if (!tab) {
        return;
      }
      onOpenChange(false);
      setMessage("");
      setAgentId(null);
      setWorktreeId(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter") {
      return;
    }
    const isModEnter = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
    if (!isModEnter || !canSubmit) {
      return;
    }
    event.preventDefault();
    void submit();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xl rounded-xl border bg-background p-5 shadow-xl">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Start a new chat</h2>
          <p className="text-sm text-muted-foreground">
            Write a prompt, pick an agent and a worktree, then launch a session.
          </p>
        </div>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-2">
            <Label>Prompt</Label>
            <MarkdownEditor
              value={message}
              onChange={setMessage}
              onKeyDown={handleKeyDown}
              placeholder="Describe what you want the agent to do…"
              className="min-h-40"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Agent</Label>
              <Select value={agentSelectValue} onValueChange={handleAgentChange}>
                <SelectTrigger
                  aria-label="Agent"
                  className="w-full"
                  onKeyDown={markAgentManuallyChanged}
                  onPointerDown={markAgentManuallyChanged}
                >
                  <span data-slot="select-value">
                    {selectedAgent ? (
                      <>
                        <AgentIcon agent={selectedAgent} />
                        <span className="truncate">{selectedAgent.name}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Select agent</span>
                    )}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {agents.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      No agents configured
                    </SelectItem>
                  ) : (
                    agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        <AgentIcon agent={agent} />
                        <span className="truncate">{agent.name}</span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Worktree</Label>
              <Select value={worktreeSelectValue} onValueChange={handleWorktreeChange}>
                <SelectTrigger
                  aria-label="Worktree"
                  className="w-full"
                  onKeyDown={markWorktreeManuallyChanged}
                  onPointerDown={markWorktreeManuallyChanged}
                >
                  <span data-slot="select-value">
                    {selectedWorktree ? (
                      <>
                        <GitBranch className="size-3.5" />
                        <span className="truncate">
                          {selectedWorktree.isMain
                            ? "main"
                            : (selectedWorktree.title ?? selectedWorktree.branch)}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Select worktree</span>
                    )}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {worktrees.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      No worktrees available
                    </SelectItem>
                  ) : (
                    worktrees.map((worktree) => (
                      <SelectItem key={worktree.id} value={worktree.id}>
                        <GitBranch className="size-3.5" />
                        <span className="truncate">
                          {worktree.isMain ? "main" : (worktree.title ?? worktree.branch)}
                        </span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              Start session
              <span className="ml-2 text-xs opacity-70">{submitShortcut}</span>
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
