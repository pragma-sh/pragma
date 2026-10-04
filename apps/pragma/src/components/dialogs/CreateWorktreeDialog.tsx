import type { FanoutParentSpec } from "@pragma-sh/constants";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { History } from "lucide-react";
import { AnimatePresence } from "motion/react";

import { AgentLaunchOptionsBar } from "@/components/agents/AgentLaunchOptions";
import { AgentModelSelector } from "@/components/agents/AgentModelSelector";
import { promptCaretPopover } from "@/components/agents/PromptContextMenu";
import { MainBehindAlert } from "@/components/dialogs/MainBehindAlert";
import { MarkdownEditor, type MarkdownEditorHandle } from "@/components/github/MarkdownEditor";
import { PromptHistoryList } from "@/components/dialogs/PromptHistoryList";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ModalShell } from "@/components/ui/modal-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAgentSelection, type AgentSelection } from "@/hooks/use-agent-selection";
import {
  type AutoRegistry,
  type AutoSelectTarget,
  useAutoSubmit,
} from "@/hooks/use-auto-agent-selection";
import {
  type AgentLaunchOptionsState,
  slashPicker,
  useAgentLaunchOptions,
  useEscapeClosesPickerFirst,
} from "@/hooks/use-agent-launch-options";
import { useAutoTarget } from "@/hooks/use-auto-target";
import { type PromptContextState, usePromptContext } from "@/hooks/use-prompt-context";
import { EMPTY_MODEL_SELECTION, rememberModelSelection } from "@/lib/agent-model-selection";
import { errorMessage } from "@/lib/errors";
import { isMacPlatform } from "@/lib/platform";
import { splitPromptCommands, withSlowCommandWarning } from "@/lib/prelaunch-commands";
import { type AgentConfig, type AgentModelSelection } from "@/lib/tauri";
import {
  readPromptHistory,
  recordPromptHistory,
  type PromptHistoryAgent,
  type PromptHistoryEntry,
} from "@/lib/worktree-prompt-history";
import { mainBehindRemote } from "@/lib/worktree-sync";
import { useWorkspace } from "@/state/workspace-context";
import { useFanouts } from "@/state/fanouts-context";
import { useWorktreeCreation } from "@/state/worktree-creation-context";
import {
  FanoutModeSwitch,
  FanoutRows,
  newFanoutRow,
  useFanoutMode,
  type FanoutMode,
} from "@/components/dialogs/FanoutRows";

interface CreateWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Parent worktree to branch from. Defaults to the currently selected
   * worktree; the sidebar's "New worktree off main" menu passes the project's
   * main worktree id explicitly.
   */
  parentWorktreeId?: string;
}

/** Structural subset shared by the DOM and React keyboard events the form fields emit. */
type SubmitKeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & {
  preventDefault: () => void;
};

/**
 * A key handler that submits on ⌘/Ctrl+↵ and ignores everything else.
 *
 * Shared by every field in the form, so the shortcut means the same thing in
 * the branch input and in the markdown editor.
 */
function submitOnModEnter(canSubmit: boolean, submit: () => void): (event: SubmitKeyEvent) => void {
  return (event) => {
    if (event.key !== "Enter") return;
    const isModEnter = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
    if (!isModEnter || !canSubmit) return;
    event.preventDefault();
    submit();
  };
}

/** Text fields for the new worktree: branch name, display title, agent prompt. */
function useWorktreeFormFields(): {
  branch: string;
  setBranch: (value: string) => void;
  title: string;
  setTitle: (value: string) => void;
  message: string;
  setMessage: (value: string) => void;
} {
  const [branch, setBranch] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  return { branch, setBranch, title, setTitle, message, setMessage };
}

/** Submission state: the pre-flight sync check and the main-behind confirmation gate. */
function useWorktreeSubmission(): {
  error: string | null;
  setError: (value: string | null) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
  behind: number;
  setBehind: (value: number) => void;
  mainWorktreeId: string | null;
  setMainWorktreeId: (value: string | null) => void;
} {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [behind, setBehind] = useState(0);
  const [mainWorktreeId, setMainWorktreeId] = useState<string | null>(null);
  return { error, setError, busy, setBusy, behind, setBehind, mainWorktreeId, setMainWorktreeId };
}

/**
 * Everything the form itself owns: its text fields, its submission gates, and
 * restoring a failed run's input when the provider republishes it as a draft.
 */
function useWorktreeForm({
  fanout,
  selection,
  seedPrompt,
}: {
  fanout: FanoutMode;
  selection: Pick<AgentSelection, "agentId" | "modelSelection" | "handleAgentChange">;
  /** Splits a restored prompt's `@` context back off (see {@link usePromptContext}). */
  seedPrompt: PromptContextState["seedPrompt"];
}): ReturnType<typeof useWorktreeFormFields> &
  ReturnType<typeof useWorktreeSubmission> & { fill: (values: FormValues) => void } {
  const fields = useWorktreeFormFields();
  const submission = useWorktreeSubmission();
  const { draft, clearDraft } = useWorktreeCreation();
  const fill = (values: FormValues) => {
    fields.setBranch(values.branch);
    fields.setTitle(values.title);
    fields.setMessage(seedPrompt(values.prompt));
    submission.setError(null);
    const [first] = values.agents;
    const seed = newFanoutRow(first?.agentId ?? null, first?.selection ?? EMPTY_MODEL_SELECTION);
    fanout.switchMode(values.mode, seed);
    if (values.mode === "fanout") {
      fanout.setRows(values.agents.map((agent) => newFanoutRow(agent.agentId, agent.selection)));
    }
    if (first?.agentId) {
      // Also re-remembers the selection, which is what the picker falls back to
      // once the agent's models resolve.
      selection.handleAgentChange(first.agentId, first.selection);
    }
  };
  useDraftRestore({ draft, clearDraft, fill });
  return { ...fields, ...submission, fill };
}

/** Everything that fills the form back out: a failed run's draft or a history entry. */
type FormValues = Pick<PromptHistoryEntry, "mode" | "branch" | "title" | "prompt" | "agents">;

/**
 * Fanout submission: turns the picker rows into the shared create request and
 * hands it to the host.
 *
 * The desktop is one caller of the same contract the CLI and the SDK use —
 * there is no desktop-only launch path — so an attempt started here is
 * indistinguishable from one started in a terminal.
 */
function useFanoutSubmit(): (input: {
  projectId: string;
  parentWorktreeId: string;
  fanout: FanoutMode;
  prompt: string;
  branch: string;
  title: string;
  /** Names the host's pre-launch command runs so **Skip** can cancel them. */
  commandRunId: string | null;
}) => Promise<void> {
  const fanouts = useFanouts();
  const workspace = useWorkspace();
  return async ({ projectId, parentWorktreeId, fanout, prompt, branch, title, commandRunId }) => {
    for (const row of fanout.rows) {
      if (row.agentId) rememberModelSelection(row.agentId, row.selection);
    }
    // A fanout always branches its own coordination parent from the worktree the
    // dialog was opened on: the attempts never land under a worktree the user is
    // already working in.
    const parent: FanoutParentSpec = {
      kind: "new",
      sourceWorktreeId: parentWorktreeId,
      branch: branch.trim(),
      title: title.trim() || null,
    };
    const result = await fanouts.create({
      projectId,
      parent,
      prompt: prompt.trim(),
      defaultReasoningId: null,
      commandRunId,
      members: fanout.rows.map((row) => ({
        selector: row.agentId ?? "",
        modelId: row.selection.modelId,
        reasoningId: row.selection.reasoningId,
      })),
    });
    // The host creates fanout worktrees and tabs. Refresh after the native RPC
    // synchronously adopts them so sidebar rows can open their live sessions.
    await workspace.refreshProject(projectId);
    // Creation does not select each attempt as it appears or open comparison.
    // The user chooses an attempt or comparison from the fanout group.
    void workspace.selectWorktree(result.fanout.parentWorktreeId);
  };
}

/**
 * Creates a nested worktree and, when a prompt is given, immediately starts an
 * agent session in it: the user names the branch (and an optional display
 * title), picks an agent, optionally writes a markdown prompt, then submits
 * (⌘/Ctrl+↵ or the button). An empty prompt just creates the worktree and opens
 * a terminal in it — no agent session is started.
 *
 * Switching to **Fan out** keeps the prompt and the first agent selection and
 * adds a second attempt row: the single-agent path stays the default, and the
 * two share every control they can.
 */
// fallow-ignore-next-line complexity -- coordinates independent form, history, fanout, and submission hooks.
export function CreateWorktreeDialog({
  open: isOpen,
  onOpenChange,
  parentWorktreeId,
}: CreateWorktreeDialogProps) {
  const workspace = useWorkspace();
  const { startCreation } = useWorktreeCreation();
  const {
    agents,
    modelsByAgent,
    agentId,
    modelSelection,
    selectedAgent,
    loadModels,
    handleAgentChange,
  } = useAgentSelection(isOpen);
  const fanoutMode = useFanoutMode();
  const submitFanout = useFanoutSubmit();
  const parentId = parentWorktreeId ?? workspace.selectedWorktreeId;
  const parent = (workspace.worktrees[workspace.selectedProjectId ?? ""] ?? []).find(
    (worktree) => worktree.id === parentId,
  );
  // The new worktree branches from `parent`, so `@` searches the parent's files.
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const context = usePromptContext({
    isOpen,
    project: workspace.activeProject,
    worktree: parent,
    editor: editorRef,
  });
  const {
    branch,
    setBranch,
    title,
    setTitle,
    message,
    setMessage,
    error,
    setError,
    busy,
    setBusy,
    behind,
    setBehind,
    mainWorktreeId,
    setMainWorktreeId,
    fill,
  } = useWorktreeForm({
    fanout: fanoutMode,
    selection: { agentId, modelSelection, handleAgentChange },
    seedPrompt: context.seedPrompt,
  });
  const isFanout = fanoutMode.isFanout;
  const launch = useWorktreeLaunchOptions({
    agent: selectedAgent,
    fanoutAgentIds: isFanout ? fanoutMode.rows.map((row) => row.agentId) : null,
    isOpen,
    busy,
    message,
    editorRef,
    context,
    onClose: () => onOpenChange(false),
  });

  const history = usePromptHistoryView(isOpen, workspace.selectedProjectId);

  const autoTarget = useAutoTarget(message, parentId);
  const canSubmit = formReady(fanoutMode, { message, branch });
  const parentLabel = parent?.title?.trim() || parent?.branch || null;

  /** Clears the form and closes the modal. */
  function reset() {
    onOpenChange(false);
    setBranch("");
    setTitle("");
    setMessage("");
    setError(null);
  }

  const { submit, confirmCreate } = useSubmission({
    branch,
    busy,
    fanout: fanoutMode,
    fields: { message, title },
    mainWorktreeId,
    modelSelection,
    applyLaunch: launch.applyToLaunch,
    attachContext: context.attachContext,
    parentId,
    ready: canSubmit,
    reset,
    selectedAgent,
    setBehind,
    setBusy,
    setError,
    setMainWorktreeId,
    startCreation,
    submitFanout,
    workspace,
  });

  const { autoRegistry, autoActive, ready, submitForm } = useFormAutoSubmit({
    submit,
    message,
    canSubmit,
  });
  const handleKeyDown = submitOnModEnter(ready, () => void submitForm());
  const handleEditorKeyDown = promptKeysThen(context, launch, handleKeyDown);

  return (
    <AnimatePresence>
      {isOpen ? (
        <ModalShell className="max-w-2xl">
          <DialogHeading
            isFanout={isFanout}
            mode={fanoutMode.mode}
            parentLabel={parentLabel}
            onSwitch={(next) => {
              history.close();
              fanoutMode.switchMode(next, newFanoutRow(agentId, modelSelection));
            }}
            history={history}
          />
          {history.showing ? (
            <PromptHistoryList
              entries={history.entries}
              onBack={history.close}
              onPick={(entry) => {
                fill(entry);
                history.close();
              }}
            />
          ) : (
            <CreateWorktreeForm
              agentPicker={
                <AgentModelSelector
                  agents={agents}
                  modelsByAgent={modelsByAgent}
                  value={{ agentId, selection: modelSelection }}
                  onChange={handleAgentChange}
                  onLoadModels={loadModels}
                  autoTarget={autoTarget}
                  autoRegistry={autoRegistry}
                />
              }
              autoTarget={autoTarget}
              autoRegistry={autoRegistry}
              autoActive={autoActive}
              agentSelection={{
                agents,
                modelsByAgent,
                agentId,
                modelSelection,
                selectedAgent,
                loadModels,
                handleAgentChange,
              }}
              branch={branch}
              busy={busy}
              error={error}
              fanout={fanoutMode}
              message={message}
              ready={ready}
              title={title}
              onBranchChange={setBranch}
              onCancel={() => onOpenChange(false)}
              onKeyDown={handleKeyDown}
              onEditorKeyDown={handleEditorKeyDown}
              editorRef={editorRef}
              launch={launch}
              context={context}
              onMessageChange={setMessage}
              onSubmit={() => void submitForm()}
              onTitleChange={setTitle}
            />
          )}
          <MainBehindAlert
            behind={behind}
            mainWorktreeId={mainWorktreeId}
            onCancel={() => setMainWorktreeId(null)}
            onConfirm={confirmCreate}
          />
        </ModalShell>
      ) : null}
    </AnimatePresence>
  );
}

/** The dialog's history view: whether it is showing, and the project's submitted runs. */
interface PromptHistoryView {
  entries: PromptHistoryEntry[];
  showing: boolean;
  toggle: () => void;
  close: () => void;
}

/**
 * History view state. Entries are re-read every time the dialog opens, so a
 * run submitted a moment ago is already listed on the next open.
 */
function usePromptHistoryView(isOpen: boolean, projectId: string | null): PromptHistoryView {
  const [showing, setShowing] = useState(false);
  const entries = useMemo(
    () => (isOpen && projectId ? readPromptHistory(projectId) : []),
    [isOpen, projectId],
  );
  useEffect(() => {
    if (!isOpen) setShowing(false);
  }, [isOpen]);
  return {
    entries,
    showing,
    toggle: () => setShowing((current) => !current),
    close: () => setShowing(false),
  };
}

/**
 * Launch options for the prompt, plus the dialog's Escape handling (an open `@`
 * or `/` picker closes first). Single mode gets the agent's full options; a
 * fanout (`fanoutAgentIds`) gets only the slash commands every attempt's agent
 * has, since one verbatim prompt goes to all of them.
 */
function useWorktreeLaunchOptions({
  agent,
  fanoutAgentIds,
  isOpen,
  busy,
  message,
  editorRef,
  context,
  onClose,
}: {
  agent: AgentConfig | null;
  /** The attempt rows' agents in fanout mode; `null` in single mode. */
  fanoutAgentIds: readonly (string | null)[] | null;
  isOpen: boolean;
  busy: boolean;
  message: string;
  editorRef: RefObject<MarkdownEditorHandle | null>;
  context: PromptContextState;
  onClose: () => void;
}): AgentLaunchOptionsState {
  const agents = fanoutAgentIds
    ? fanoutAgentIds.filter((id): id is string => id !== null)
    : (agent?.id ?? null);
  const launch = useAgentLaunchOptions(agents, isOpen, message, editorRef);
  useEscapeClosesPickerFirst(isOpen && !busy, [context, slashPicker(launch)], onClose);
  return launch;
}

/** Editor key handler: the `@` picker, then the `/` picker and Shift+Tab, then `fallback`. */
function promptKeysThen(
  context: PromptContextState,
  launch: AgentLaunchOptionsState,
  fallback: (event: SubmitKeyEvent) => void,
): (event: KeyboardEvent) => void {
  return (event) => {
    context.handleKeyDown(event);
    if (!event.defaultPrevented) launch.handleKeyDown(event);
    if (!event.defaultPrevented) fallback(event);
  };
}

/**
 * Restores a failed run's input when the provider republishes it as a draft.
 *
 * "Try again" on the creation-failure screen reopens this dialog, and the user
 * came here to fix one thing — so the branch, title, prompt, and agent + model
 * come back exactly as they were submitted rather than being retyped.
 */
function useDraftRestore({
  draft,
  clearDraft,
  fill,
}: {
  draft: ReturnType<typeof useWorktreeCreation>["draft"];
  clearDraft: () => void;
  fill: (values: FormValues) => void;
}): void {
  useEffect(() => {
    if (!draft) return;
    clearDraft();
    fill({
      // A draft only ever comes from the single-worktree path.
      mode: "single",
      branch: draft.branch,
      title: draft.title ?? "",
      prompt: draft.prompt ?? "",
      agents: draft.agent
        ? [
            {
              agentId: draft.agent.id,
              selection: draft.modelSelection ?? EMPTY_MODEL_SELECTION,
            },
          ]
        : [],
    });
    // Restoring runs once per published draft; `fill` only calls stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
}

/** Modal heading: the parent it branches from, the History toggle, and the Single | Fan out switch. */
function DialogHeading({
  parentLabel,
  mode,
  isFanout,
  onSwitch,
  history,
}: {
  parentLabel: string | null;
  mode: "single" | "fanout";
  isFanout: boolean;
  onSwitch: (next: "single" | "fanout") => void;
  history: PromptHistoryView;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          {parentLabel ? `New worktree at ${parentLabel}` : "New worktree"}
        </h2>
        <div className="flex items-center gap-1">
          <IconButton
            aria-pressed={history.showing}
            className={history.showing ? "bg-muted text-foreground" : undefined}
            label="History"
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={history.toggle}
          >
            <History className="size-3.5" />
          </IconButton>
          <FanoutModeSwitch mode={mode} onSwitch={onSwitch} />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {headingDescription(isFanout, history.showing)}
      </p>
    </div>
  );
}

/** The heading's one-line explanation of the current view. */
function headingDescription(isFanout: boolean, showingHistory: boolean): string {
  if (showingHistory) return "Pick a previously submitted prompt to fill the form back out.";
  return isFanout
    ? "Runs one prompt in several isolated attempts under one parent, then lets you compare them and keep one."
    : "Branches from the selected parent worktree HEAD. Add a prompt to launch an agent session in it.";
}

/** Branch name, display title, and (single mode only) the agent picker. */
function IdentityFields({
  branch,
  title,
  agent,
  onBranchChange,
  onTitleChange,
  onKeyDown,
}: {
  branch: string;
  title: string;
  agent: ReactNode;
  onBranchChange: (value: string) => void;
  onTitleChange: (value: string) => void;
  onKeyDown: (event: SubmitKeyEvent) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="space-y-2">
        <Label htmlFor="branch">Branch name</Label>
        <Input
          id="branch"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          value={branch}
          onChange={(event) => onBranchChange(event.target.value.replace(/\s+/g, "-"))}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="title">Display title</Label>
        <Input
          id="title"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {agent ? (
        <div className="space-y-2">
          <Label>Agent</Label>
          {agent}
        </div>
      ) : null}
    </div>
  );
}

/** Everything {@link useSubmission} needs to run either creation path. */
interface SubmissionInput {
  workspace: ReturnType<typeof useWorkspace>;
  startCreation: ReturnType<typeof useWorktreeCreation>["startCreation"];
  submitFanout: ReturnType<typeof useFanoutSubmit>;
  fanout: FanoutMode;
  parentId: string | null;
  branch: string;
  fields: { title: string; message: string };
  selectedAgent: AgentConfig | null;
  modelSelection: AgentModelSelection;
  applyLaunch: AgentLaunchOptionsState["applyToLaunch"];
  attachContext: PromptContextState["attachContext"];
  ready: boolean;
  busy: boolean;
  mainWorktreeId: string | null;
  reset: () => void;
  setBusy: (value: boolean) => void;
  setError: (value: string | null) => void;
  setBehind: (value: number) => void;
  setMainWorktreeId: (value: string | null) => void;
}

/**
 * The dialog's submission flow, kept out of the component so the component
 * stays layout plus wiring.
 *
 * Single-worktree creation hands off to the full-frame progress screen. Fanout
 * creation stays here until the host has provisioned and the desktop has loaded
 * every created worktree and agent tab.
 */
function useSubmission(input: SubmissionInput): {
  submit: () => Promise<void>;
  confirmCreate: (pullFirst: boolean) => void;
} {
  const { workspace, fanout, parentId, branch, fields, reset } = input;

  /** Adds the run to the dialog's history; a worktree without a prompt is not worth recalling. */
  function remember(
    projectId: string,
    mode: PromptHistoryEntry["mode"],
    prompt: string,
    agents: PromptHistoryAgent[],
  ) {
    if (!prompt.trim()) return;
    recordPromptHistory(projectId, { mode, branch, title: fields.title.trim(), prompt, agents });
  }

  /** Hands a single-worktree run off to the background creation flow. */
  async function handOff(syncWorktreeId: string | null) {
    const projectId = workspace.selectedProjectId;
    if (!projectId || !parentId) return;
    // `@` context is appended here; a failed run's draft is split again on restore.
    const prompt = (await input.attachContext(fields.message)).trim();
    if (prompt && input.selectedAgent) {
      rememberModelSelection(input.selectedAgent.id, input.modelSelection);
    }
    remember(projectId, "single", prompt, [
      { agentId: input.selectedAgent?.id ?? null, selection: input.modelSelection },
    ]);
    input.startCreation({
      projectId,
      parentWorktreeId: parentId,
      branch,
      title: fields.title.trim() || undefined,
      prompt,
      agent: input.selectedAgent,
      // The prompt stays verbatim (a failed run restores it as a draft), so a
      // leading `/command` is typed as-is; only the mode and permission ride along.
      modelSelection: {
        ...input.applyLaunch(input.modelSelection, fields.message).selection,
        slashCommand: null,
      },
      syncWorktreeId,
    });
    reset();
  }

  /**
   * Creates the fanout. The host runs the prompt's `!!` commands in each
   * attempt's worktree before its agent starts, so a slow run gets the same
   * warning and **Skip** as a single launch, cancelled by `commandRunId`.
   */
  async function runFanout(projectId: string, parent: string) {
    const prompt = await input.attachContext(fields.message);
    remember(
      projectId,
      "fanout",
      prompt,
      fanout.rows.map((row) => ({ agentId: row.agentId, selection: row.selection })),
    );
    const submit = (commandRunId: string | null) =>
      input.submitFanout({
        projectId,
        parentWorktreeId: parent,
        fanout,
        prompt,
        branch,
        title: fields.title,
        commandRunId,
      });
    const { commands } = splitPromptCommands(fields.message);
    if (commands.length === 0) {
      await submit(null);
      return;
    }
    await withSlowCommandWarning(parent, commands.length, "the attempts", submit);
  }

  /** Runs whichever mode is active. */
  async function run(projectId: string, parent: string) {
    if (fanout.isFanout) {
      await runFanout(projectId, parent);
      reset();
      return;
    }
    // Ask about syncing only when the project's main worktree is behind.
    const behindMain = await mainBehindRemote(workspace.worktrees[projectId] ?? []);
    if (behindMain) {
      input.setBehind(behindMain.behind);
      input.setMainWorktreeId(behindMain.id);
      return;
    }
    await handOff(null);
  }

  return {
    submit: async () => {
      const projectId = workspace.selectedProjectId;
      if (!projectId || !parentId || !input.ready || input.busy) return;
      input.setBusy(true);
      input.setError(null);
      try {
        await run(projectId, parentId);
      } catch (cause) {
        input.setError(errorMessage(cause));
      } finally {
        input.setBusy(false);
      }
    },
    confirmCreate: (pullFirst) => {
      const mainId = input.mainWorktreeId;
      input.setMainWorktreeId(null);
      void handOff(pullFirst ? mainId : null).catch((cause: unknown) => {
        input.setError(errorMessage(cause));
      });
    },
  };
}

/**
 * Routes the form's submit through its Auto pickers. With no prompt no agent
 * starts, so there is nothing for Auto to decide and the submit goes straight
 * through.
 */
function useFormAutoSubmit({
  submit,
  message,
  canSubmit,
}: {
  submit: () => Promise<void>;
  message: string;
  canSubmit: boolean;
}): {
  autoRegistry: AutoRegistry;
  autoActive: boolean;
  ready: boolean;
  submitForm: () => Promise<void>;
} {
  const auto = useAutoSubmit(submit);
  return {
    autoRegistry: auto.registry,
    autoActive: auto.active,
    ready: canSubmit && !auto.resolving,
    submitForm: () => (message.trim() ? auto.submit() : submit()),
  };
}

/** Whether the form can submit: what its mode needs (a branch, plus the attempts for a fanout). */
function formReady(
  fanout: FanoutMode,
  { message, branch }: { message: string; branch: string },
): boolean {
  return fanout.isFanout ? fanout.ready(message, branch) : branch.trim().length > 0;
}

/** Props for {@link CreateWorktreeForm}. */
interface CreateWorktreeFormProps {
  fanout: FanoutMode;
  branch: string;
  title: string;
  message: string;
  /** The single-mode agent picker; ignored in fanout mode. */
  agentPicker: ReactNode;
  agentSelection: AgentSelection;
  /** What an attempt row set to Auto decides for. */
  autoTarget: AutoSelectTarget;
  /** Where attempt rows set to Auto register, to be decided on submit. */
  autoRegistry: AutoRegistry;
  /** Whether a picker is on Auto: the agent is unknown, so its launch options are hidden. */
  autoActive: boolean;
  error: string | null;
  busy: boolean;
  ready: boolean;
  onBranchChange: (value: string) => void;
  onTitleChange: (value: string) => void;
  onMessageChange: (value: string) => void;
  onKeyDown: (event: SubmitKeyEvent) => void;
  /** Prompt-editor keys: the `@` and `/` pickers and Shift+Tab, then {@link onKeyDown}. */
  onEditorKeyDown: (event: KeyboardEvent) => void;
  editorRef: RefObject<MarkdownEditorHandle | null>;
  /** Launch options: the single agent's, or a fanout's shared slash commands. */
  launch: AgentLaunchOptionsState;
  /** The `@` context picker, offered in both modes. */
  context: PromptContextState;
  onSubmit: () => void;
  onCancel: () => void;
}

/** Copy that differs between the two modes, resolved in one place. */
function modeCopy(isFanout: boolean): { submitLabel: string; promptPlaceholder: string } {
  return isFanout
    ? {
        submitLabel: "Create & Fanout",
        promptPlaceholder:
          "Describe what every attempt should do. Type @ for context, !! to run a shell command in each attempt first…",
      }
    : {
        submitLabel: "Create worktree",
        promptPlaceholder:
          "Describe what you want the agent to do. Type @ for context, !! to run a shell command first… (leave empty to skip the session)",
      };
}

/** The repeatable attempt rows, shown in fanout mode only. */
function FanoutFields({
  fanout,
  agentSelection,
  autoTarget,
  autoRegistry,
  children,
}: {
  fanout: FanoutMode;
  agentSelection: AgentSelection;
  autoTarget: AutoSelectTarget;
  autoRegistry: AutoRegistry;
  /** The identity fields, rendered above the rows. */
  children: ReactNode;
}) {
  if (!fanout.isFanout) {
    return children;
  }
  return (
    <>
      {children}
      <FanoutRows
        autoRegistry={autoRegistry}
        autoTarget={autoTarget}
        rows={fanout.rows}
        selection={agentSelection}
        onChange={fanout.setRows}
      />
    </>
  );
}

/** The create-worktree form body, in whichever mode is active. */
function CreateWorktreeForm(props: CreateWorktreeFormProps): ReactNode {
  const { fanout, branch, title, message, error, busy } = props;
  const isFanout = fanout.isFanout;
  const { submitLabel, promptPlaceholder } = modeCopy(isFanout);
  return (
    <form
      className="mt-5 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <FanoutFields
        agentSelection={props.agentSelection}
        autoRegistry={props.autoRegistry}
        autoTarget={props.autoTarget}
        fanout={fanout}
      >
        <IdentityFields
          agent={isFanout ? null : props.agentPicker}
          branch={branch}
          title={title}
          onBranchChange={props.onBranchChange}
          onKeyDown={props.onKeyDown}
          onTitleChange={props.onTitleChange}
        />
      </FanoutFields>
      <div className="space-y-2">
        <Label>Prompt</Label>
        <MarkdownEditor
          value={message}
          onChange={props.onMessageChange}
          onKeyDown={props.onEditorKeyDown}
          handleRef={props.editorRef}
          onCaretTextChange={props.context.onCaretTextChange}
          caretPopover={promptCaretPopover(props.context, props.launch)}
          placeholder={promptPlaceholder}
          className="min-h-40"
          shellCommands
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        <div className="mr-auto min-w-0">
          <AgentLaunchOptionsBar launch={props.launch} auto={props.autoActive} />
        </div>
        <Button disabled={busy} type="button" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!props.ready || busy}>
          {busy ? "Working…" : submitLabel}
          <span className="ml-2 text-xs opacity-70">{isMacPlatform() ? "⌘↵" : "Ctrl+↵"}</span>
        </Button>
      </div>
    </form>
  );
}
