import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import {
  type AgentConfig,
  type AgentModel,
  type AgentModelSelection,
  listAgents,
} from "@/lib/tauri";
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

/** Setters used to seed the draft form from a card (or empty for a new draft). */
interface DraftSetters {
  setBranch: (value: string) => void;
  setPrompt: (value: string) => void;
  setAgentId: (value: string | null) => void;
  setModelSelection: (value: AgentModelSelection) => void;
  setError: (value: string | null) => void;
  setPreviousAgent: (id: string | null) => void;
}

/** Model selection seeded from a card's saved model id (or the empty default). */
function seedModelSelection(modelId: string | null): AgentModelSelection {
  return modelId ? { modelId, reasoningId: null } : EMPTY_MODEL_SELECTION;
}

/** Seed the form from an existing draft card. */
function seedFromCard(card: KanbanPromptCard, apply: DraftSetters): void {
  apply.setBranch(card.branchName);
  apply.setPrompt(card.prompt);
  apply.setAgentId(card.agentId);
  apply.setPreviousAgent(card.agentId);
  apply.setModelSelection(seedModelSelection(card.modelId ?? null));
  apply.setError(null);
}

/** Seed the form for a brand-new draft (empty fields). */
function seedNewDraft(apply: DraftSetters): void {
  apply.setBranch("");
  apply.setPrompt("");
  apply.setAgentId(null);
  apply.setPreviousAgent(null);
  apply.setModelSelection(EMPTY_MODEL_SELECTION);
  apply.setError(null);
}

/** True for a plain or modifier Enter (⌘/Ctrl) without Shift/Alt. */
function isModEnter(event: SubmitKeyEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
}

/** Submit on modifier-Enter when the form is submittable. */
function submitOnModEnter(event: SubmitKeyEvent, canSubmit: boolean, submit: () => void): void {
  if (event.key !== "Enter") return;
  if (!isModEnter(event) || !canSubmit) return;
  event.preventDefault();
  void submit();
}

/** Load configured agents whenever the dialog opens. */
function useDraftAgents(open: boolean, setAgents: (agents: AgentConfig[]) => void) {
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listAgents()
      .then((items) => {
        if (!cancelled) setAgents(Array.isArray(items) ? items : []);
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, setAgents]);
}

/** Seed the form from the edited card (or empty for a new draft) when opened. */
function useDraftSeed(
  open: boolean,
  card: KanbanPromptCard | null,
  wasOpenRef: RefObject<boolean>,
  apply: DraftSetters,
) {
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      if (card) seedFromCard(card, apply);
      else seedNewDraft(apply);
    }
    wasOpenRef.current = open;
  }, [open, card, apply, wasOpenRef]);
}

/** Keep a valid agent selected, falling back to the first (default) agent. */
function useDraftAgentFallback(
  open: boolean,
  agents: AgentConfig[],
  setAgentId: (update: (current: string | null) => string | null) => void,
) {
  useEffect(() => {
    if (!open || agents.length === 0) return;
    setAgentId((current) =>
      current && agents.some((agent) => agent.id === current) ? current : agents[0]!.id,
    );
  }, [open, agents, setAgentId]);
}

/** Sync the model selection when the agent changes or its model list loads. */
function useDraftModelSync(
  open: boolean,
  agentId: string | null,
  modelsByAgent: Record<string, AgentModel[] | undefined>,
  previousAgentIdRef: RefObject<string | null>,
  setModelSelection: (update: (current: AgentModelSelection) => AgentModelSelection) => void,
) {
  useEffect(() => {
    if (!open || !agentId) return;
    const models = modelsByAgent[agentId];
    if (!models) return;
    const changedAgent = previousAgentIdRef.current !== agentId;
    previousAgentIdRef.current = agentId;
    setModelSelection((current) =>
      changedAgent
        ? defaultModelSelection(agentId, models)
        : validateModelSelection(models, current),
    );
  }, [open, agentId, modelsByAgent, previousAgentIdRef, setModelSelection]);
}

/** Branch options for the draft's branch combobox (existing project worktree branches). */
function useDraftBranchOptions(workspace: ReturnType<typeof useWorkspace>): string[] {
  return useMemo(() => {
    const worktrees = workspace.selectedProjectId
      ? (workspace.worktrees[workspace.selectedProjectId] ?? [])
      : [];
    return [...new Set(worktrees.map((worktree) => worktree.branch))];
  }, [workspace.selectedProjectId, workspace.worktrees]);
}

/** Prime the model cache for any agents already resolved. */
function useDraftPrimeModels(agents: AgentConfig[], primeFromCache: (agentIds: string[]) => void) {
  useEffect(() => {
    primeFromCache(agents.map((agent) => agent.id));
  }, [agents, primeFromCache]);
}

/** All reactive draft-form fields plus the agent/model loaders. */
function useDraftFormState() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const { modelsByAgent, loadModels, primeFromCache } = useAgentModels();
  const [branch, setBranch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<AgentModelSelection>(EMPTY_MODEL_SELECTION);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const previousAgentIdRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);
  return {
    agents,
    setAgents,
    modelsByAgent,
    loadModels,
    primeFromCache,
    branch,
    setBranch,
    prompt,
    setPrompt,
    agentId,
    setAgentId,
    modelSelection,
    setModelSelection,
    error,
    setError,
    busy,
    setBusy,
    previousAgentIdRef,
    wasOpenRef,
  };
}

interface DraftHandlersContext {
  card: KanbanPromptCard | null;
  agentId: string | null;
  branch: string;
  prompt: string;
  modelSelection: AgentModelSelection;
  kanban: ReturnType<typeof useKanban>;
  onOpenChange: (open: boolean) => void;
  setBusy: (value: boolean) => void;
  setError: (value: string | null) => void;
  setAgentId: (value: string | null) => void;
  setModelSelection: (value: AgentModelSelection) => void;
  canSubmit: boolean;
}

/** Submit/discard/agent-change/keyboard handlers for the draft form. */
function useDraftHandlers(ctx: DraftHandlersContext) {
  const {
    setAgentId,
    setModelSelection,
    setBusy,
    setError,
    onOpenChange,
    kanban,
    agentId,
    branch,
    prompt,
    modelSelection,
    card,
    canSubmit,
  } = ctx;
  const handleAgentChange = useCallback(
    (nextAgentId: string, nextSelection: AgentModelSelection) => {
      setAgentId(nextAgentId);
      setModelSelection(nextSelection);
      rememberModelSelection(nextAgentId, nextSelection);
    },
    [setAgentId, setModelSelection],
  );
  const submit = useCallback(async () => {
    if (!agentId || branch.trim().length === 0) return;
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
  }, [agentId, branch, prompt, modelSelection, card, kanban, onOpenChange, setBusy, setError]);
  const discard = useCallback(async () => {
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
  }, [card, kanban, onOpenChange, setBusy, setError]);
  const handleKeyDown = useCallback(
    (event: SubmitKeyEvent) => submitOnModEnter(event, canSubmit, () => void submit()),
    [canSubmit, submit],
  );
  return { handleAgentChange, submit, discard, handleKeyDown };
}

/** Owns all draft-form state, effects, and handlers. */
function useKanbanDraftForm({ open, card, onOpenChange }: KanbanDraftDialogProps) {
  const kanban = useKanban();
  const workspace = useWorkspace();
  const state = useDraftFormState();
  const setPreviousAgent = useCallback(
    (id: string | null) => {
      state.previousAgentIdRef.current = id;
    },
    [state.previousAgentIdRef],
  );
  const apply: DraftSetters = useMemo(
    () => ({
      setBranch: state.setBranch,
      setPrompt: state.setPrompt,
      setAgentId: state.setAgentId,
      setModelSelection: state.setModelSelection,
      setError: state.setError,
      setPreviousAgent,
    }),
    [
      setPreviousAgent,
      state.setBranch,
      state.setPrompt,
      state.setAgentId,
      state.setModelSelection,
      state.setError,
    ],
  );
  const branchOptions = useDraftBranchOptions(workspace);

  useDraftAgents(open, state.setAgents);
  useDraftPrimeModels(state.agents, state.primeFromCache);
  useDraftSeed(open, card, state.wasOpenRef, apply);
  useDraftAgentFallback(open, state.agents, state.setAgentId);
  useDraftModelSync(
    open,
    state.agentId,
    state.modelsByAgent,
    state.previousAgentIdRef,
    state.setModelSelection,
  );

  const canSubmit = state.branch.trim().length > 0 && Boolean(state.agentId) && !state.busy;
  const handlers = useDraftHandlers({
    agentId: state.agentId,
    branch: state.branch,
    canSubmit,
    card,
    kanban,
    modelSelection: state.modelSelection,
    onOpenChange,
    prompt: state.prompt,
    setAgentId: state.setAgentId,
    setBusy: state.setBusy,
    setError: state.setError,
    setModelSelection: state.setModelSelection,
  });

  return {
    agents: state.agents,
    modelsByAgent: state.modelsByAgent,
    loadModels: state.loadModels,
    branch: state.branch,
    setBranch: state.setBranch,
    prompt: state.prompt,
    setPrompt: state.setPrompt,
    agentId: state.agentId,
    modelSelection: state.modelSelection,
    error: state.error,
    busy: state.busy,
    canSubmit,
    branchOptions,
    ...handlers,
  };
}

/**
 * Creates or edits a Kanban draft card. The user writes a markdown prompt, picks
 * an agent/model, and selects an existing project worktree branch or types a new
 * one (a native combobox via `<datalist>`). Editing an existing draft also offers
 * Discard, which deletes the card.
 */
export function KanbanDraftDialog({ open: isOpen, onOpenChange, card }: KanbanDraftDialogProps) {
  const form = useKanbanDraftForm({ open: isOpen, onOpenChange, card });
  const submitShortcut = isMacPlatform() ? "⌘↵" : "Ctrl+↵";
  useEscapeToClose(isOpen, () => onOpenChange(false));

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
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
            void form.submit();
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
                value={form.branch}
                onChange={(event) => form.setBranch(event.target.value.replace(/\s+/g, "-"))}
                onKeyDown={form.handleKeyDown}
              />
              <datalist id="kanban-branch-options">
                {form.branchOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <Label>Agent</Label>
              <AgentModelSelector
                agents={form.agents}
                modelsByAgent={form.modelsByAgent}
                value={{ agentId: form.agentId, selection: form.modelSelection }}
                onChange={form.handleAgentChange}
                onLoadModels={form.loadModels}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Prompt</Label>
            <MarkdownEditor
              value={form.prompt}
              onChange={form.setPrompt}
              onKeyDown={form.handleKeyDown}
              placeholder="Describe what you want the agent to do…"
              className="min-h-40 max-h-[40vh] overflow-y-auto"
            />
          </div>
          {form.error ? <p className="text-sm text-destructive">{form.error}</p> : null}
          <div className="flex justify-between gap-2">
            <div>
              {card ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={form.busy}
                  onClick={() => void form.discard()}
                >
                  Discard
                </Button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!form.canSubmit}>
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
