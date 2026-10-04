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

import { AnimatePresence } from "motion/react";
import { GitBranch } from "lucide-react";

import { AgentLaunchOptionsBar } from "@/components/agents/AgentLaunchOptions";
import { AgentModelSelector } from "@/components/agents/AgentModelSelector";
import { promptCaretPopover } from "@/components/agents/PromptContextMenu";
import { MarkdownEditor, type MarkdownEditorHandle } from "@/components/github/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ModalShell } from "@/components/ui/modal-shell";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useAutoSubmit } from "@/hooks/use-auto-agent-selection";
import {
  type AgentLaunchOptionsState,
  slashPicker,
  useAgentLaunchOptions,
  useEscapeClosesPickerFirst,
} from "@/hooks/use-agent-launch-options";
import { useAgentModels } from "@/hooks/use-agent-models";
import { useAutoTarget } from "@/hooks/use-auto-target";
import { type PromptContextState, usePromptContext } from "@/hooks/use-prompt-context";
import {
  EMPTY_MODEL_SELECTION,
  defaultModelSelection,
  rememberModelSelection,
  resolveDeepLinkAgentSelection,
  validateModelSelection,
} from "@/lib/agent-model-selection";
import type { NewSessionDeepLinkDetail } from "@/lib/deep-link";
import { isMacPlatform } from "@/lib/platform";
import { splitPromptCommands, startSessionAfterCommands } from "@/lib/prelaunch-commands";
import type { AgentConfig, AgentModelSelection } from "@/lib/tauri";
import { listPluginAgents } from "@/plugins/agents";
import { worktreeDisplayLabel } from "@/lib/non-git-project";
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
  selectedWorktree: WorktreeLike | null;
  worktreeSelectValue: string;
  canSubmit: boolean;
}

interface SessionFormApi extends SessionFormState, SessionFormSelection {
  agents: AgentConfig[];
  modelsByAgent: ReturnType<typeof useAgentModels>["modelsByAgent"];
  loadModels: ReturnType<typeof useAgentModels>["loadModels"];
  worktrees: WorktreeLike[];
  error: string | null;
  launch: AgentLaunchOptionsState;
  context: PromptContextState;
  editorRef: RefObject<MarkdownEditorHandle | null>;
  setMessage: (message: string) => void;
  handleAgentChange: (nextAgentId: string, nextSelection: AgentModelSelection) => void;
  handleWorktreeChange: (nextWorktreeId: string) => void;
  markAgentManuallyChanged: () => void;
  markWorktreeManuallyChanged: () => void;
  submit: () => Promise<void>;
}

type WorktreeLike = {
  id: string;
  isMain: boolean;
  title: string | null;
  branch: string;
  path: string;
};

/** Load the configured agents whenever the dialog opens. */
function useAgentSessionAgents(isOpen: boolean, setAgents: (agents: AgentConfig[]) => void): void {
  useEffect(() => {
    if (!isOpen) return;
    setAgents(listPluginAgents());
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
  applyLaunch: AgentLaunchOptionsState["applyToLaunch"];
  attachContext: PromptContextState["attachContext"];
  workspace: ReturnType<typeof useWorkspace>;
  onOpenChange: (open: boolean) => void;
  setMessage: (message: string) => void;
  setAgentId: (id: string | null) => void;
  setModelSelection: (selection: AgentModelSelection) => void;
  setWorktreeId: (id: string | null) => void;
  setError: (error: string | null) => void;
}

/**
 * Persist the model choice, start the session, then reset the form on success.
 * With `!!` command chips in the prompt the dialog closes at once: the commands
 * run headlessly in the worktree and the session starts once they finish, with
 * the rest of the prompt followed by each command's output.
 */
async function submitAgentSession(ctx: SubmitContext): Promise<void> {
  const worktreeId = ctx.effectiveWorktreeId;
  const agent = ctx.selectedAgent;
  if (!worktreeId || !agent) return;
  try {
    rememberModelSelection(agent.id, ctx.modelSelection);
    // A leading `/command` becomes the launch's slash command; mode and
    // permission mode ride along on the selection.
    // `!!` chips are commands to run first, not part of what the agent reads.
    const { prompt: text, commands } = splitPromptCommands(ctx.message);
    const launch = ctx.applyLaunch(ctx.modelSelection, text);
    // `@` mentions still in the prompt carry their resolved context along.
    const prompt = await ctx.attachContext(launch.prompt);
    const start = (message: string | undefined, focus: boolean) =>
      ctx.workspace.startSession(worktreeId, agent, message, launch.selection, { focus });
    if (commands.length > 0) {
      closeSessionForm(ctx);
      void startSessionAfterCommands({
        worktreeId,
        agentLabel: agent.name,
        commands,
        prompt,
        start,
        open: (tab) =>
          void ctx.workspace.activateTabLocation(tab.projectId, tab.worktreeId, tab.id),
      });
      return;
    }
    const tab = await start(prompt.trim() ? prompt : undefined, true);
    if (!tab) return;
    closeSessionForm(ctx);
  } catch (cause) {
    ctx.setError(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Close the dialog and clear every field for the next session. */
function closeSessionForm(ctx: SubmitContext): void {
  ctx.onOpenChange(false);
  ctx.setMessage("");
  ctx.setAgentId(null);
  ctx.setModelSelection(EMPTY_MODEL_SELECTION);
  ctx.setWorktreeId(null);
  ctx.setError(null);
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
    dialog: { isOpen, initial },
    agent: { agents, modelsByAgent, primeFromCache, selectedAgentId },
    worktree: {
      worktrees,
      loadedWorktrees,
      worktreeId,
      selectedWorktreeId: workspace.selectedWorktreeId,
    },
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

  const handlers = useSessionFormHandlers(isOpen, {
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

interface SessionFormEffectsArgs {
  refs: RefObject<SessionFormRefs>;
  dialog: {
    isOpen: boolean;
    initial: NewSessionDeepLinkDetail | null | undefined;
  };
  agent: {
    agents: AgentConfig[];
    modelsByAgent: ReturnType<typeof useAgentModels>["modelsByAgent"];
    primeFromCache: ReturnType<typeof useAgentModels>["primeFromCache"];
    selectedAgentId: string | null;
  };
  worktree: {
    worktrees: WorktreeLike[];
    loadedWorktrees: WorktreeLike[];
    worktreeId: string | null;
    selectedWorktreeId: string | null;
  };
  setters: SessionFormSetters;
}

/** Wires the form's seeding/selection/worktree side effects. */
function useSessionFormEffects({
  refs,
  dialog,
  agent,
  worktree,
  setters,
}: SessionFormEffectsArgs): void {
  const { isOpen, initial } = dialog;
  const { agents, modelsByAgent, primeFromCache, selectedAgentId } = agent;
  const { worktrees, loadedWorktrees, worktreeId, selectedWorktreeId } = worktree;

  useEffect(() => {
    primeFromCache(agents.map((agentItem) => agentItem.id));
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

/**
 * Launch options for the selected agent and the `@` context picker for the
 * selected worktree, plus the prompt editor they both rewrite.
 */
function useSessionLaunchOptions(
  agent: AgentConfig | null,
  isOpen: boolean,
  message: string,
  worktree: WorktreeLike | null,
  project: ReturnType<typeof useWorkspace>["activeProject"],
): {
  launch: AgentLaunchOptionsState;
  context: PromptContextState;
  editorRef: RefObject<MarkdownEditorHandle | null>;
} {
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const launch = useAgentLaunchOptions(agent?.id ?? null, isOpen, message, editorRef);
  const context = usePromptContext({ isOpen, project, worktree, editor: editorRef });
  return { launch, context, editorRef };
}

/**
 * Builds the form's stable event handlers (agent/worktree changes, submit,
 * shortcuts) and owns the selected agent's launch options, which both submit
 * and the prompt's key handling read.
 */
function useSessionFormHandlers(
  isOpen: boolean,
  {
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
  },
): {
  handleAgentChange: (nextAgentId: string, nextSelection: AgentModelSelection) => void;
  handleWorktreeChange: (nextWorktreeId: string) => void;
  markAgentManuallyChanged: () => void;
  markWorktreeManuallyChanged: () => void;
  submit: () => Promise<void>;
  launch: AgentLaunchOptionsState;
  context: PromptContextState;
  editorRef: RefObject<MarkdownEditorHandle | null>;
} {
  const { launch, context, editorRef } = useSessionLaunchOptions(
    selection.selectedAgent,
    isOpen,
    message,
    selection.selectedWorktree,
    workspace.activeProject,
  );
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
      // Radix's hidden native <select> reports "" when its options are not
      // mounted (e.g. under jsdom); never let that clear a real selection.
      if (nextWorktreeId) setWorktreeId(nextWorktreeId);
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
      applyLaunch: launch.applyToLaunch,
      attachContext: context.attachContext,
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
    launch.applyToLaunch,
    context.attachContext,
    workspace,
    onOpenChange,
    setAgentId,
    setModelSelection,
    setWorktreeId,
    setMessage,
    setError,
  ]);
  return {
    handleAgentChange,
    handleWorktreeChange,
    markAgentManuallyChanged,
    markWorktreeManuallyChanged,
    submit,
    launch,
    context,
    editorRef,
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
  const autoTarget = useAutoTarget(form.message, form.effectiveWorktreeId);
  const auto = useAutoSubmit(form.submit);
  const canSubmit = form.canSubmit && !auto.resolving;
  const handleEditorKeyDown = (event: KeyboardEvent) => {
    form.context.handleKeyDown(event);
    if (!event.defaultPrevented) form.launch.handleKeyDown(event);
    if (!event.defaultPrevented) handleSessionKeyDown(event, canSubmit, auto.submit);
  };
  const submitShortcut = isMacPlatform() ? "⌘↵" : "Ctrl+↵";
  useEscapeClosesPickerFirst(isOpen, [form.context, slashPicker(form.launch)], () =>
    onOpenChange(false),
  );

  return (
    <AnimatePresence>
      {isOpen ? (
        <ModalShell className="max-w-xl">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">New agent session</h2>
            <p className="text-sm text-muted-foreground">
              Write a prompt, pick an agent and a worktree, then launch a session. Type / for
              commands, @ to attach files, issues, or pull requests, and !! for a shell command to
              run first — the agent gets its output.
            </p>
          </div>
          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) void auto.submit();
            }}
          >
            <div className="space-y-2">
              <Label>Prompt</Label>
              <MarkdownEditor
                value={form.message}
                onChange={form.setMessage}
                onKeyDown={handleEditorKeyDown}
                handleRef={form.editorRef}
                onCaretTextChange={form.context.onCaretTextChange}
                caretPopover={promptCaretPopover(form.context, form.launch)}
                placeholder="Describe what you want the agent to do. Type / for commands, @ for context, !! to run a shell command first…"
                className="min-h-40"
                shellCommands
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
                  autoTarget={autoTarget}
                  autoRegistry={auto.registry}
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
                            {worktreeDisplayLabel(form.selectedWorktree, workspace.activeProject)}
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
                            {worktreeDisplayLabel(worktree, workspace.activeProject)}
                          </span>
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {form.error ? <p className="text-sm text-destructive">{form.error}</p> : null}
            <div className="flex items-center gap-2">
              <div className="mr-auto min-w-0">
                <AgentLaunchOptionsBar launch={form.launch} auto={auto.active} />
              </div>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                Start session
                <span className="ml-2 text-xs opacity-70">{submitShortcut}</span>
              </Button>
            </div>
          </form>
        </ModalShell>
      ) : null}
    </AnimatePresence>
  );
}
