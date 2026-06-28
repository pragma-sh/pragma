import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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

/** Mutable form flags tracked across renders (manual-change guards, open/seed tracking). */
interface SessionFormRefs {
  wasOpen: boolean;
  lastInitial: NewSessionDeepLinkDetail | null | undefined;
  agentManuallyChanged: boolean;
  worktreeManuallyChanged: boolean;
  previousAgentId: string | null;
}

/** Setters shared by the form's seed/effect helpers. Agent/model setters accept updaters. */
interface SessionFormSetters {
  setMessage: (message: string) => void;
  setWorktreeId: (id: string | null) => void;
  setAgentId: Dispatch<SetStateAction<string | null>>;
  setModelSelection: Dispatch<SetStateAction<AgentModelSelection>>;
}

interface SessionFormState {
  message: string;
  agentId: string | null;
  modelSelection: AgentModelSelection;
  worktreeId: string | null;
}

interface SessionFormSelection {
  effectiveAgentId: string | null;
  effectiveWorktreeId: string | null;
  selectedAgent: AgentConfig | null;
  selectedWorktree: { id: string; isMain: boolean; title: string | null; branch: string } | null;
  worktreeSelectValue: string;
  canSubmit: boolean;
}

interface SessionFormApi extends SessionFormState, SessionFormSelection {
  agents: AgentConfig[];
  modelsByAgent: ReturnType<typeof useAgentModels>["modelsByAgent"];
  loadModels: ReturnType<typeof useAgentModels>["loadModels"];
  worktrees: WorktreeLike[];
  error: string | null;
  setMessage: (message: string) => void;
  handleAgentChange: (nextAgentId: string, nextSelection: AgentModelSelection) => void;
  handleWorktreeChange: (nextWorktreeId: string) => void;
  markAgentManuallyChanged: () => void;
  markWorktreeManuallyChanged: () => void;
  submit: () => Promise<void>;
  handleKeyDown: (event: KeyboardEvent) => void;
}

type WorktreeLike = { id: string; isMain: boolean; title: string | null; branch: string };

/** Load the configured agents whenever the dialog opens. */
function useAgentSessionAgents(isOpen: boolean, setAgents: (agents: AgentConfig[]) => void): void {
  useEffect(() => {
    if (!isOpen) return;
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
  }, [isOpen, setAgents]);
}

/** Seed the form on open or when a fresh deep-link payload arrives while open. */
function applyFormSeed(
  refs: SessionFormRefs,
  isOpen: boolean,
  initial: NewSessionDeepLinkDetail | null | undefined,
  selectedWorktreeId: string | null,
  setters: SessionFormSetters,
): void {
  const opened = isOpen && !refs.wasOpen;
  const receivedInitial = isOpen && initial !== refs.lastInitial;
  if (opened || receivedInitial) {
    refs.agentManuallyChanged = false;
    refs.worktreeManuallyChanged = false;
    resetSessionForm(setters, initial, selectedWorktreeId);
    refs.previousAgentId = null;
  }
  refs.wasOpen = isOpen;
  refs.lastInitial = initial;
}

/** Reset every form field to its seed values (deep-link payload or defaults). */
function resetSessionForm(
  setters: SessionFormSetters,
  initial: NewSessionDeepLinkDetail | null | undefined,
  selectedWorktreeId: string | null,
): void {
  setters.setMessage(initial?.message ?? "");
  setters.setWorktreeId(initial?.worktreeId ?? selectedWorktreeId);
  setters.setAgentId(initial?.agentId ?? null);
  setters.setModelSelection(EMPTY_MODEL_SELECTION);
}

/** Resolve the agent selection: keep a valid choice, otherwise fall back to the default. */
function resolveAgentOnOpen(
  refs: SessionFormRefs,
  isOpen: boolean,
  initial: NewSessionDeepLinkDetail | null | undefined,
  agents: AgentConfig[],
  modelsByAgent: ReturnType<typeof useAgentModels>["modelsByAgent"],
  setAgentId: Dispatch<SetStateAction<string | null>>,
  setModelSelection: Dispatch<SetStateAction<AgentModelSelection>>,
): void {
  if (!isOpen || agents.length === 0) return;
  if (initial?.agentId && !refs.agentManuallyChanged) {
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
}

/** Resolve the model selection when the chosen agent or its model list changes. */
function resolveModelOnOpen(
  refs: SessionFormRefs,
  isOpen: boolean,
  initial: NewSessionDeepLinkDetail | null | undefined,
  agents: AgentConfig[],
  modelsByAgent: ReturnType<typeof useAgentModels>["modelsByAgent"],
  selectedAgentId: string | null,
  setModelSelection: Dispatch<SetStateAction<AgentModelSelection>>,
): void {
  if (!isOpen || !selectedAgentId) return;
  const models = modelsByAgent[selectedAgentId];
  if (!models) return;
  const changedAgent = refs.previousAgentId !== selectedAgentId;
  refs.previousAgentId = selectedAgentId;
  if (initial?.agentId && !refs.agentManuallyChanged) {
    setModelSelection(resolveDeepLinkAgentSelection(initial, agents, modelsByAgent).selection);
    return;
  }
  setModelSelection((current) =>
    changedAgent
      ? defaultModelSelection(selectedAgentId, models)
      : validateModelSelection(models, current),
  );
}

/** Apply a deep-link-requested worktree unless the user already changed it manually. */
function applyWorktreeFromInitial(
  refs: SessionFormRefs,
  isOpen: boolean,
  initial: NewSessionDeepLinkDetail | null | undefined,
  worktrees: WorktreeLike[],
  loadedWorktrees: WorktreeLike[],
  setWorktreeId: (id: string | null) => void,
): void {
  const requestedWorktreeId = initial?.worktreeId;
  if (!isOpen || !requestedWorktreeId || refs.worktreeManuallyChanged) return;
  if (
    worktrees.some((worktree) => worktree.id === requestedWorktreeId) ||
    loadedWorktrees.some((worktree) => worktree.id === requestedWorktreeId)
  ) {
    setWorktreeId(requestedWorktreeId);
  }
}

/** Default to the currently selected worktree when no choice has been made yet. */
function applyDefaultWorktree(
  isOpen: boolean,
  initial: NewSessionDeepLinkDetail | null | undefined,
  worktreeId: string | null,
  selectedWorktreeId: string | null,
  setWorktreeId: (id: string | null) => void,
): void {
  if (isOpen && !initial?.worktreeId && worktreeId === null && selectedWorktreeId) {
    setWorktreeId(selectedWorktreeId);
  }
}

/** Deep-link-requested agent id, unless the user already changed it manually. */
function resolveRequestedAgent(
  refs: SessionFormRefs,
  initial: NewSessionDeepLinkDetail | null | undefined,
  agents: AgentConfig[],
  modelsByAgent: ReturnType<typeof useAgentModels>["modelsByAgent"],
): string | null {
  if (!refs.agentManuallyChanged && initial?.agentId) {
    return resolveDeepLinkAgentSelection(initial, agents, modelsByAgent).agentId;
  }
  return null;
}

/** Deep-link-requested worktree id, unless the user already changed it manually. */
function resolveRequestedWorktree(
  refs: SessionFormRefs,
  initial: NewSessionDeepLinkDetail | null | undefined,
  loadedWorktrees: WorktreeLike[],
): string | null {
  if (
    !refs.worktreeManuallyChanged &&
    initial?.worktreeId &&
    loadedWorktrees.some((w) => w.id === initial.worktreeId)
  ) {
    return initial.worktreeId;
  }
  return null;
}

/** Find the selected worktree across visible and loaded worktrees. */
function resolveSelectedWorktree(
  worktrees: WorktreeLike[],
  loadedWorktrees: WorktreeLike[],
  effectiveWorktreeId: string | null,
): WorktreeLike | null {
  if (!effectiveWorktreeId) return null;
  return (
    worktrees.find((worktree) => worktree.id === effectiveWorktreeId) ??
    loadedWorktrees.find((worktree) => worktree.id === effectiveWorktreeId) ??
    null
  );
}

/** Compute the effective agent/worktree selection and derived submit readiness. */
function computeSessionFormSelection(
  refs: SessionFormRefs,
  initial: NewSessionDeepLinkDetail | null | undefined,
  agents: AgentConfig[],
  modelsByAgent: ReturnType<typeof useAgentModels>["modelsByAgent"],
  agentId: string | null,
  worktreeId: string | null,
  worktrees: WorktreeLike[],
  loadedWorktrees: WorktreeLike[],
): SessionFormSelection {
  const effectiveAgentId = resolveRequestedAgent(refs, initial, agents, modelsByAgent) ?? agentId;
  const effectiveWorktreeId =
    resolveRequestedWorktree(refs, initial, loadedWorktrees) ?? worktreeId;
  const selectedAgent = effectiveAgentId
    ? (agents.find((agent) => agent.id === effectiveAgentId) ?? null)
    : null;
  const selectedWorktree = resolveSelectedWorktree(worktrees, loadedWorktrees, effectiveWorktreeId);
  return {
    effectiveAgentId,
    effectiveWorktreeId,
    selectedAgent,
    selectedWorktree,
    worktreeSelectValue: effectiveWorktreeId ?? "",
    canSubmit: Boolean(selectedAgent && effectiveWorktreeId),
  };
}

interface SubmitContext {
  effectiveWorktreeId: string | null;
  selectedAgent: AgentConfig | null;
  message: string;
  modelSelection: AgentModelSelection;
  workspace: ReturnType<typeof useWorkspace>;
  onOpenChange: (open: boolean) => void;
  setMessage: (message: string) => void;
  setAgentId: (id: string | null) => void;
  setModelSelection: (selection: AgentModelSelection) => void;
  setWorktreeId: (id: string | null) => void;
  setError: (error: string | null) => void;
}

/** Persist the model choice, start the session, then reset the form on success. */
async function submitAgentSession(ctx: SubmitContext): Promise<void> {
  if (!ctx.effectiveWorktreeId || !ctx.selectedAgent) return;
  try {
    rememberModelSelection(ctx.selectedAgent.id, ctx.modelSelection);
    const tab = await ctx.workspace.startSession(
      ctx.effectiveWorktreeId,
      ctx.selectedAgent,
      ctx.message.trim() ? ctx.message : undefined,
      ctx.modelSelection,
    );
    if (!tab) return;
    ctx.onOpenChange(false);
    ctx.setMessage("");
    ctx.setAgentId(null);
    ctx.setModelSelection(EMPTY_MODEL_SELECTION);
    ctx.setWorktreeId(null);
    ctx.setError(null);
  } catch (cause) {
    ctx.setError(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Launch the session on ⌘/Ctrl+↵ (no shift/alt) when the form is submittable. */
function handleSessionKeyDown(
  event: KeyboardEvent,
  canSubmit: boolean,
  submit: () => Promise<void>,
): void {
  if (event.key !== "Enter") return;
  const isModEnter = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
  if (!isModEnter || !canSubmit) return;
  event.preventDefault();
  void submit();
}

/** Owns the new-session form state, effects, and handlers. */
function useNewAgentSessionForm({
  isOpen,
  onOpenChange,
  initial,
  workspace,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  initial: NewSessionDeepLinkDetail | null | undefined;
  workspace: ReturnType<typeof useWorkspace>;
}): SessionFormApi {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const { modelsByAgent, loadModels, primeFromCache } = useAgentModels();
  const [message, setMessage] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<AgentModelSelection>(EMPTY_MODEL_SELECTION);
  const [worktreeId, setWorktreeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refs = useRef<SessionFormRefs>({
    wasOpen: false,
    lastInitial: undefined,
    agentManuallyChanged: false,
    worktreeManuallyChanged: false,
    previousAgentId: null,
  });

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

  useAgentSessionAgents(isOpen, setAgents);
  const selectedAgentId = agentId && agents.some((agent) => agent.id === agentId) ? agentId : null;
  useSessionFormEffects({
    refs,
    isOpen,
    initial,
    selectedWorktreeId: workspace.selectedWorktreeId,
    agents,
    modelsByAgent,
    primeFromCache,
    selectedAgentId,
    worktrees,
    loadedWorktrees,
    worktreeId,
    setters: { setMessage, setWorktreeId, setAgentId, setModelSelection },
  });

  const selection = computeSessionFormSelection(
    refs.current,
    initial,
    agents,
    modelsByAgent,
    agentId,
    worktreeId,
    worktrees,
    loadedWorktrees,
  );

  const handlers = useSessionFormHandlers({
    refs,
    selection,
    message,
    modelSelection,
    workspace,
    onOpenChange,
    setAgentId,
    setModelSelection,
    setWorktreeId,
    setMessage,
    setError,
  });

  return {
    agents,
    modelsByAgent,
    loadModels,
    worktrees,
    message,
    setMessage,
    agentId,
    modelSelection,
    worktreeId,
    error,
    ...selection,
    ...handlers,
  };
}

/** Wires the form's seeding/selection/worktree side effects. */
function useSessionFormEffects({
  refs,
  isOpen,
  initial,
  selectedWorktreeId,
  agents,
  modelsByAgent,
  primeFromCache,
  selectedAgentId,
  worktrees,
  loadedWorktrees,
  worktreeId,
  setters,
}: {
  refs: RefObject<SessionFormRefs>;
  isOpen: boolean;
  initial: NewSessionDeepLinkDetail | null | undefined;
  selectedWorktreeId: string | null;
  agents: AgentConfig[];
  modelsByAgent: ReturnType<typeof useAgentModels>["modelsByAgent"];
  primeFromCache: ReturnType<typeof useAgentModels>["primeFromCache"];
  selectedAgentId: string | null;
  worktrees: WorktreeLike[];
  loadedWorktrees: WorktreeLike[];
  worktreeId: string | null;
  setters: SessionFormSetters;
}): void {
  useEffect(() => {
    primeFromCache(agents.map((agent) => agent.id));
  }, [agents, primeFromCache]);

  useEffect(() => {
    applyFormSeed(refs.current, isOpen, initial, selectedWorktreeId, setters);
  }, [refs, isOpen, initial, selectedWorktreeId, setters]);

  useEffect(() => {
    resolveAgentOnOpen(
      refs.current,
      isOpen,
      initial,
      agents,
      modelsByAgent,
      setters.setAgentId,
      setters.setModelSelection,
    );
  }, [refs, isOpen, initial, agents, modelsByAgent, setters]);

  useEffect(() => {
    resolveModelOnOpen(
      refs.current,
      isOpen,
      initial,
      agents,
      modelsByAgent,
      selectedAgentId,
      setters.setModelSelection,
    );
  }, [refs, isOpen, selectedAgentId, initial, agents, modelsByAgent, setters.setModelSelection]);

  useEffect(() => {
    applyWorktreeFromInitial(
      refs.current,
      isOpen,
      initial,
      worktrees,
      loadedWorktrees,
      setters.setWorktreeId,
    );
  }, [refs, isOpen, initial, loadedWorktrees, worktrees, setters.setWorktreeId]);

  useEffect(() => {
    applyDefaultWorktree(isOpen, initial, worktreeId, selectedWorktreeId, setters.setWorktreeId);
  }, [isOpen, initial, worktreeId, selectedWorktreeId, setters.setWorktreeId]);
}

/** Builds the form's stable event handlers (agent/worktree changes, submit, shortcuts). */
function useSessionFormHandlers({
  refs,
  selection,
  message,
  modelSelection,
  workspace,
  onOpenChange,
  setAgentId,
  setModelSelection,
  setWorktreeId,
  setMessage,
  setError,
}: {
  refs: RefObject<SessionFormRefs>;
  selection: SessionFormSelection;
  message: string;
  modelSelection: AgentModelSelection;
  workspace: ReturnType<typeof useWorkspace>;
  onOpenChange: (open: boolean) => void;
  setAgentId: (id: string | null) => void;
  setModelSelection: (selection: AgentModelSelection) => void;
  setWorktreeId: (id: string | null) => void;
  setMessage: (message: string) => void;
  setError: (error: string | null) => void;
}): {
  handleAgentChange: (nextAgentId: string, nextSelection: AgentModelSelection) => void;
  handleWorktreeChange: (nextWorktreeId: string) => void;
  markAgentManuallyChanged: () => void;
  markWorktreeManuallyChanged: () => void;
  submit: () => Promise<void>;
  handleKeyDown: (event: KeyboardEvent) => void;
} {
  const handleAgentChange = useCallback(
    (nextAgentId: string, nextSelection: AgentModelSelection) => {
      refs.current.agentManuallyChanged = true;
      setAgentId(nextAgentId);
      setModelSelection(nextSelection);
      rememberModelSelection(nextAgentId, nextSelection);
    },
    [refs, setAgentId, setModelSelection],
  );
  const handleWorktreeChange = useCallback(
    (nextWorktreeId: string) => {
      setWorktreeId(nextWorktreeId);
    },
    [setWorktreeId],
  );
  const markAgentManuallyChanged = useCallback(() => {
    refs.current.agentManuallyChanged = true;
  }, [refs]);
  const markWorktreeManuallyChanged = useCallback(() => {
    refs.current.worktreeManuallyChanged = true;
  }, [refs]);
  const submit = useCallback(() => {
    return submitAgentSession({
      effectiveWorktreeId: selection.effectiveWorktreeId,
      selectedAgent: selection.selectedAgent,
      message,
      modelSelection,
      workspace,
      onOpenChange,
      setMessage,
      setAgentId,
      setModelSelection,
      setWorktreeId,
      setError,
    });
  }, [
    selection.effectiveWorktreeId,
    selection.selectedAgent,
    message,
    modelSelection,
    workspace,
    onOpenChange,
    setAgentId,
    setModelSelection,
    setWorktreeId,
    setMessage,
    setError,
  ]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => handleSessionKeyDown(event, selection.canSubmit, submit),
    [selection.canSubmit, submit],
  );
  return {
    handleAgentChange,
    handleWorktreeChange,
    markAgentManuallyChanged,
    markWorktreeManuallyChanged,
    submit,
    handleKeyDown,
  };
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
  const form = useNewAgentSessionForm({ isOpen, onOpenChange, initial, workspace });
  const submitShortcut = isMacPlatform() ? "⌘↵" : "Ctrl+↵";
  useEscapeToClose(isOpen, () => onOpenChange(false));

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
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
            void form.submit();
          }}
        >
          <div className="space-y-2">
            <Label>Prompt</Label>
            <MarkdownEditor
              value={form.message}
              onChange={form.setMessage}
              onKeyDown={form.handleKeyDown}
              placeholder="Describe what you want the agent to do…"
              className="min-h-40"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Agent</Label>
              <AgentModelSelector
                agents={form.agents}
                modelsByAgent={form.modelsByAgent}
                value={{ agentId: form.effectiveAgentId, selection: form.modelSelection }}
                onChange={form.handleAgentChange}
                onLoadModels={form.loadModels}
                onInteract={form.markAgentManuallyChanged}
              />
            </div>
            <div className="space-y-2">
              <Label>Worktree</Label>
              <Select value={form.worktreeSelectValue} onValueChange={form.handleWorktreeChange}>
                <SelectTrigger
                  aria-label="Worktree"
                  className="w-full"
                  onKeyDown={form.markWorktreeManuallyChanged}
                  onPointerDown={form.markWorktreeManuallyChanged}
                >
                  <span data-slot="select-value">
                    {form.selectedWorktree ? (
                      <>
                        <GitBranch className="size-3.5" />
                        <span className="truncate">
                          {form.selectedWorktree.isMain
                            ? "main"
                            : (form.selectedWorktree.title ?? form.selectedWorktree.branch)}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Select worktree</span>
                    )}
                  </span>
                </SelectTrigger>
                <SelectContent position="popper">
                  {form.worktrees.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      No worktrees available
                    </SelectItem>
                  ) : (
                    form.worktrees.map((worktree) => (
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
          {form.error ? <p className="text-sm text-destructive">{form.error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!form.canSubmit}>
              Start session
              <span className="ml-2 text-xs opacity-70">{submitShortcut}</span>
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
