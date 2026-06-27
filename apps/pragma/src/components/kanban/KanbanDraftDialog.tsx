import { useEffect, useMemo, useRef, useState } from "react";

import type { KanbanPromptCard } from "@pragma/constants";

import { AgentModelSelector } from "@/components/agents/AgentModelSelector";
import { MarkdownEditor } from "@/components/github/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAgentModels } from "@/hooks/use-agent-models";
import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import {
  EMPTY_MODEL_SELECTION,
  defaultModelSelection,
  rememberModelSelection,
  validateModelSelection,
} from "@/lib/agent-model-selection";
import { isMacPlatform } from "@/lib/platform";
import { type AgentConfig, type AgentModelSelection, listAgents } from "@/lib/tauri";
import { useKanban } from "@/state/kanban-context";
import { useWorkspace } from "@/state/workspace-context";

interface KanbanDraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The draft card to edit; null creates a new draft. */
  card: KanbanPromptCard | null;
}

/** Structural subset shared by the DOM and React keyboard events the form emits. */
type SubmitKeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & {
  preventDefault: () => void;
};

/**
 * Creates or edits a Kanban draft card. The user writes a markdown prompt, picks
 * an agent/model, and selects an existing project worktree branch or types a new
 * one (a native combobox via `<datalist>`). Editing an existing draft also offers
 * Discard, which deletes the card.
 */
export function KanbanDraftDialog({ open: isOpen, onOpenChange, card }: KanbanDraftDialogProps) {
  const kanban = useKanban();
  const workspace = useWorkspace();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const { modelsByAgent, loadModels, primeFromCache } = useAgentModels();
  const [branch, setBranch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<AgentModelSelection>(EMPTY_MODEL_SELECTION);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const previousAgentIdRef = useRef<string | null>(null);
  const submitShortcut = isMacPlatform() ? "⌘↵" : "Ctrl+↵";
  useEscapeToClose(isOpen, () => onOpenChange(false));

  const branchOptions = useMemo(() => {
    const worktrees = workspace.selectedProjectId
      ? (workspace.worktrees[workspace.selectedProjectId] ?? [])
      : [];
    return [...new Set(worktrees.map((worktree) => worktree.branch))];
  }, [workspace.selectedProjectId, workspace.worktrees]);

  // Load configured agents whenever the dialog opens.
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

  useEffect(() => {
    primeFromCache(agents.map((agent) => agent.id));
  }, [agents, primeFromCache]);

  // Seed the form from the edited card (or empty for a new draft) when opened.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setBranch(card?.branchName ?? "");
      setPrompt(card?.prompt ?? "");
      setAgentId(card?.agentId ?? null);
      setModelSelection(
        card?.modelId ? { modelId: card.modelId, reasoningId: null } : EMPTY_MODEL_SELECTION,
      );
      previousAgentIdRef.current = card?.agentId ?? null;
      setError(null);
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, card]);

  // Keep a valid agent selected, falling back to the first (default) agent.
  useEffect(() => {
    if (!isOpen || agents.length === 0) {
      return;
    }
    setAgentId((current) =>
      current && agents.some((agent) => agent.id === current) ? current : agents[0]!.id,
    );
  }, [isOpen, agents]);

  useEffect(() => {
    if (!isOpen || !agentId) {
      return;
    }
    const models = modelsByAgent[agentId];
    if (!models) {
      return;
    }
    const changedAgent = previousAgentIdRef.current !== agentId;
    previousAgentIdRef.current = agentId;
    setModelSelection((current) =>
      changedAgent
        ? defaultModelSelection(agentId, models)
        : validateModelSelection(models, current),
    );
  }, [isOpen, agentId, modelsByAgent]);

  if (!isOpen) {
    return null;
  }

  const canSubmit = branch.trim().length > 0 && Boolean(agentId) && !busy;

  function handleAgentChange(nextAgentId: string, nextSelection: AgentModelSelection) {
    setAgentId(nextAgentId);
    setModelSelection(nextSelection);
    rememberModelSelection(nextAgentId, nextSelection);
  }

  async function submit() {
    if (!agentId || branch.trim().length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = {
        branchName: branch.trim(),
        prompt,
        agentId,
        modelId: modelSelection.modelId,
      };
      if (card) {
        await kanban.updateCardDraft(card, input);
      } else {
        await kanban.createCard(input);
      }
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!card) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await kanban.deleteCard(card);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(event: SubmitKeyEvent) {
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
          <h2 className="text-lg font-semibold">{card ? "Edit draft" : "New prompt draft"}</h2>
          <p className="text-sm text-muted-foreground">
            Pick an agent and a branch, write a prompt, then save. Move the draft to In progress to
            launch it.
          </p>
        </div>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="kanban-branch">Branch</Label>
              <Input
                id="kanban-branch"
                list="kanban-branch-options"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                placeholder="existing or new branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value.replace(/\s+/g, "-"))}
                onKeyDown={handleKeyDown}
              />
              <datalist id="kanban-branch-options">
                {branchOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <Label>Agent</Label>
              <AgentModelSelector
                agents={agents}
                modelsByAgent={modelsByAgent}
                value={{ agentId, selection: modelSelection }}
                onChange={handleAgentChange}
                onLoadModels={loadModels}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Prompt</Label>
            <MarkdownEditor
              value={prompt}
              onChange={setPrompt}
              onKeyDown={handleKeyDown}
              placeholder="Describe what you want the agent to do…"
              className="min-h-40 max-h-[40vh] overflow-y-auto"
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-between gap-2">
            <div>
              {card ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void discard()}
                >
                  Discard
                </Button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {card ? "Save draft" : "Add draft"}
                <span className="ml-2 text-xs opacity-70">{submitShortcut}</span>
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
