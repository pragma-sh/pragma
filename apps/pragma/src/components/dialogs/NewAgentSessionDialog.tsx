import { useEffect, useMemo, useRef, useState } from "react";

import { GitBranch } from "lucide-react";

import { AgentModelSelector } from "@/components/agents/AgentModelSelector";
import { MarkdownEditor } from "@/components/github/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useAgentModels } from "@/hooks/use-agent-models";
import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import {
  EMPTY_MODEL_SELECTION,
  defaultModelSelection,
  rememberModelSelection,
  resolveDeepLinkAgentSelection,
  validateModelSelection,
} from "@/lib/agent-model-selection";
import type { NewSessionDeepLinkDetail } from "@/lib/deep-link";
import { isMacPlatform } from "@/lib/platform";
import { type AgentConfig, type AgentModelSelection, listAgents } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

interface NewAgentSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Values to seed the form with when the dialog opens (e.g. from a deep link). */
  initial?: NewSessionDeepLinkDetail | null;
}

/**
 * Starts a fresh agent session: the user writes a markdown prompt, picks an agent
 * and a target worktree, then submits (⌘/Ctrl+↵ or the button). Submitting
 * switches to the chosen worktree, opens a terminal tab, launches the agent, and
 * submits the prompt to the agent when non-empty.
 */
export function NewAgentSessionDialog({
  open: isOpen,
  onOpenChange,
  initial,
}: NewAgentSessionDialogProps) {
  const workspace = useWorkspace();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const { modelsByAgent, loadModels, primeFromCache } = useAgentModels();
  const [message, setMessage] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<AgentModelSelection>(EMPTY_MODEL_SELECTION);
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

  // Show already-resolved models immediately, without waiting for a hover.
  useEffect(() => {
    primeFromCache(agents.map((agent) => agent.id));
  }, [agents, primeFromCache]);

  // Seed the form when the dialog opens, and also when a fresh deep-link payload
  // arrives while it is open. Avoid reseeding on unrelated re-renders so the
  // user's edits are not clobbered.
  const wasOpenRef = useRef(false);
  const lastInitialRef = useRef<NewSessionDeepLinkDetail | null | undefined>(undefined);
  const agentManuallyChangedRef = useRef(false);
  const worktreeManuallyChangedRef = useRef(false);
  const previousAgentIdRef = useRef<string | null>(null);
  useEffect(() => {
    const opened = isOpen && !wasOpenRef.current;
    const receivedInitial = isOpen && initial !== lastInitialRef.current;
    if (opened || receivedInitial) {
      agentManuallyChangedRef.current = false;
      worktreeManuallyChangedRef.current = false;
      setMessage(initial?.message ?? "");
      setWorktreeId(initial?.worktreeId ?? workspace.selectedWorktreeId);
      setAgentId(initial?.agentId ?? null);
      setModelSelection(EMPTY_MODEL_SELECTION);
      previousAgentIdRef.current = null;
    }
    wasOpenRef.current = isOpen;
    lastInitialRef.current = initial;
  }, [isOpen, initial, workspace.selectedWorktreeId]);

  // Resolve the agent selection: keep a valid choice, otherwise fall back to the
  // first (default) agent — also covers deep links with compact selectors.
  useEffect(() => {
    if (!isOpen || agents.length === 0) {
      return;
    }
    if (initial?.agentId && !agentManuallyChangedRef.current) {
      const resolved = resolveDeepLinkAgentSelection(initial, agents, modelsByAgent);
      if (resolved.agentId) {
        setAgentId(resolved.agentId);
        setModelSelection(resolved.selection);
        return;
      }
    }
    setAgentId((current) =>
      current && agents.some((agent) => agent.id === current) ? current : agents[0]!.id,
    );
  }, [isOpen, initial, agents, modelsByAgent]);

  const selectedAgentId = agentId && agents.some((agent) => agent.id === agentId) ? agentId : null;
  useEffect(() => {
    if (!isOpen || !selectedAgentId) {
      return;
    }
    const models = modelsByAgent[selectedAgentId];
    if (!models) {
      return;
    }
    const changedAgent = previousAgentIdRef.current !== selectedAgentId;
    previousAgentIdRef.current = selectedAgentId;
    if (initial?.agentId && !agentManuallyChangedRef.current) {
      setModelSelection(resolveDeepLinkAgentSelection(initial, agents, modelsByAgent).selection);
      return;
    }
    setModelSelection((current) =>
      changedAgent
        ? defaultModelSelection(selectedAgentId, models)
        : validateModelSelection(models, current),
    );
  }, [isOpen, selectedAgentId, initial, agents, modelsByAgent]);

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

  const requestedAgentId =
    !agentManuallyChangedRef.current && initial?.agentId
      ? resolveDeepLinkAgentSelection(initial, agents, modelsByAgent).agentId
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
  const worktreeSelectValue = effectiveWorktreeId ?? "";
  const canSubmit = Boolean(selectedAgent && effectiveWorktreeId);

  if (!isOpen) {
    return null;
  }

  function handleAgentChange(nextAgentId: string, nextSelection: AgentModelSelection) {
    markAgentManuallyChanged();
    setAgentId(nextAgentId);
    setModelSelection(nextSelection);
    rememberModelSelection(nextAgentId, nextSelection);
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
      rememberModelSelection(selectedAgent.id, modelSelection);
      const tab = await workspace.startSession(
        effectiveWorktreeId,
        selectedAgent,
        message.trim() ? message : undefined,
        modelSelection,
      );
      if (!tab) {
        return;
      }
      onOpenChange(false);
      setMessage("");
      setAgentId(null);
      setModelSelection(EMPTY_MODEL_SELECTION);
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
          <h2 className="text-lg font-semibold">New agent session</h2>
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
              <AgentModelSelector
                agents={agents}
                modelsByAgent={modelsByAgent}
                value={{ agentId: effectiveAgentId, selection: modelSelection }}
                onChange={handleAgentChange}
                onLoadModels={loadModels}
                onInteract={markAgentManuallyChanged}
              />
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
                <SelectContent position="popper">
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
