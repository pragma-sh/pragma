import type { FanoutParentSpec, Worktree } from "@pragma/constants";
import { useState, type ReactNode } from "react";

import { AgentModelSelector } from "@/components/agents/AgentModelSelector";
import { MarkdownEditor } from "@/components/github/MarkdownEditor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAgentSelection, type AgentSelection } from "@/hooks/use-agent-selection";
import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import { rememberModelSelection } from "@/lib/agent-model-selection";
import { errorMessage } from "@/lib/errors";
import { isMacPlatform } from "@/lib/platform";
import { githubFetchAndSync, type AgentConfig, type AgentModelSelection } from "@/lib/tauri";
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

interface MainBehindAlertProps {
  behind: number;
  mainWorktreeId: string | null;
  onCancel: () => void;
  onConfirm: (pullFirst: boolean) => void;
}

function MainBehindAlert({ behind, mainWorktreeId, onCancel, onConfirm }: MainBehindAlertProps) {
  return (
    <AlertDialog open={mainWorktreeId !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Main is behind remote</AlertDialogTitle>
          <AlertDialogDescription>
            Main has {behind} commit{behind === 1 ? "" : "s"} to sync. Sync before creating this
            worktree?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="outline" onClick={() => onConfirm(false)}>
            Create without syncing
          </Button>
          <AlertDialogAction onClick={() => onConfirm(true)}>Sync and create</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Fetches the main worktree's sync status, treating a failed fetch (offline,
 * auth lapsed, remote unreachable) as "status unknown" rather than an error —
 * matching the ChangesTab behaviour so a flaky fetch never blocks creation.
 */
async function fetchMainSyncStatus(
  mainWorktreeId: string,
): Promise<Awaited<ReturnType<typeof githubFetchAndSync>> | null> {
  try {
    return await githubFetchAndSync(mainWorktreeId);
  } catch {
    return null;
  }
}

/**
 * The project's main worktree when it is behind its remote, so the caller can
 * offer to sync before branching off it. A failed fetch reads as "not behind":
 * a flaky network must never block creation.
 */
async function mainBehindRemote(
  worktrees: readonly Worktree[],
): Promise<{ id: string; behind: number } | null> {
  const main = worktrees.find((worktree) => worktree.isMain);
  if (!main) {
    throw new Error("Project main worktree was not found.");
  }
  const status = await fetchMainSyncStatus(main.id);
  return status && status.behind > 0 ? { id: main.id, behind: status.behind } : null;
}

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
}) => Promise<void> {
  const fanouts = useFanouts();
  const workspace = useWorkspace();
  return async ({ projectId, parentWorktreeId, fanout, prompt, branch, title }) => {
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
      members: fanout.rows.map((row) => ({
        selector: row.agentId ?? "",
        modelId: row.selection.modelId,
        reasoningId: row.selection.reasoningId,
      })),
    });
    // Creation does not select each attempt as it appears, and it does not open
    // the comparison: nothing has run yet, so comparing would only show an
    // empty state. The user opens it from the fanout group when ready.
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
  const { branch, setBranch, title, setTitle, message, setMessage } = useWorktreeFormFields();
  const fanoutMode = useFanoutMode();
  const submitFanout = useFanoutSubmit();
  const { error, setError, busy, setBusy, behind, setBehind, mainWorktreeId, setMainWorktreeId } =
    useWorktreeSubmission();
  useEscapeToClose(isOpen, () => onOpenChange(false));

  if (!isOpen) {
    return null;
  }

  const isFanout = fanoutMode.isFanout;
  const canSubmit = isFanout ? fanoutMode.ready(message, branch) : branch.trim().length > 0;
  const parentId = parentWorktreeId ?? workspace.selectedWorktreeId;
  const parent = (workspace.worktrees[workspace.selectedProjectId ?? ""] ?? []).find(
    (worktree) => worktree.id === parentId,
  );
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

  const handleKeyDown = submitOnModEnter(canSubmit, () => void submit());

  return (
    <ModalShell className="max-w-2xl">
      <DialogHeading
        isFanout={isFanout}
        mode={fanoutMode.mode}
        parentLabel={parentLabel}
        onSwitch={(next) => fanoutMode.switchMode(next, newFanoutRow(agentId, modelSelection))}
      />
      <CreateWorktreeForm
        agentPicker={
          <AgentModelSelector
            agents={agents}
            modelsByAgent={modelsByAgent}
            value={{ agentId, selection: modelSelection }}
            onChange={handleAgentChange}
            onLoadModels={loadModels}
          />
        }
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
        ready={canSubmit}
        title={title}
        onBranchChange={setBranch}
        onCancel={() => onOpenChange(false)}
        onKeyDown={handleKeyDown}
        onMessageChange={setMessage}
        onSubmit={submit}
        onTitleChange={setTitle}
      />
      <MainBehindAlert
        behind={behind}
        mainWorktreeId={mainWorktreeId}
        onCancel={() => setMainWorktreeId(null)}
        onConfirm={confirmCreate}
      />
    </ModalShell>
  );
}

/** Modal heading: the parent it branches from, and the Single | Fan out switch. */
function DialogHeading({
  parentLabel,
  mode,
  isFanout,
  onSwitch,
}: {
  parentLabel: string | null;
  mode: "single" | "fanout";
  isFanout: boolean;
  onSwitch: (next: "single" | "fanout") => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          {parentLabel ? `New worktree at ${parentLabel}` : "New worktree"}
        </h2>
        <FanoutModeSwitch mode={mode} onSwitch={onSwitch} />
      </div>
      <p className="text-sm text-muted-foreground">
        {isFanout
          ? "Runs one prompt in several isolated attempts under one parent, then lets you compare them and keep one."
          : "Branches from the selected parent worktree HEAD. Add a prompt to launch an agent session in it."}
      </p>
    </div>
  );
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
 * Both paths end the same way — the modal closes immediately and progress is
 * reported elsewhere (the full-frame creation screen for a single worktree, the
 * host's fanout record for a fanout) — so neither ever blocks the app.
 */
function useSubmission(input: SubmissionInput): {
  submit: () => Promise<void>;
  confirmCreate: (pullFirst: boolean) => void;
} {
  const { workspace, fanout, parentId, branch, fields, reset } = input;

  /** Hands a single-worktree run off to the background creation flow. */
  function handOff(syncWorktreeId: string | null) {
    const projectId = workspace.selectedProjectId;
    if (!projectId || !parentId) return;
    const prompt = fields.message.trim();
    if (prompt && input.selectedAgent) {
      rememberModelSelection(input.selectedAgent.id, input.modelSelection);
    }
    input.startCreation({
      projectId,
      parentWorktreeId: parentId,
      branch,
      title: fields.title.trim() || undefined,
      prompt,
      agent: input.selectedAgent,
      modelSelection: input.modelSelection,
      syncWorktreeId,
    });
    reset();
  }

  /** Runs whichever mode is active. */
  async function run(projectId: string, parent: string) {
    if (fanout.isFanout) {
      await input.submitFanout({
        projectId,
        parentWorktreeId: parent,
        fanout,
        prompt: fields.message,
        branch,
        title: fields.title,
      });
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
    handOff(null);
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
      handOff(pullFirst ? mainId : null);
    },
  };
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
  error: string | null;
  busy: boolean;
  ready: boolean;
  onBranchChange: (value: string) => void;
  onTitleChange: (value: string) => void;
  onMessageChange: (value: string) => void;
  onKeyDown: (event: SubmitKeyEvent) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** Copy that differs between the two modes, resolved in one place. */
function modeCopy(isFanout: boolean): { submitLabel: string; promptPlaceholder: string } {
  return isFanout
    ? {
        submitLabel: "Create & Fanout",
        promptPlaceholder: "Describe what every attempt should do…",
      }
    : {
        submitLabel: "Create worktree",
        promptPlaceholder:
          "Describe what you want the agent to do… (leave empty to skip the session)",
      };
}

/** The repeatable attempt rows, shown in fanout mode only. */
function FanoutFields({
  fanout,
  agentSelection,
  children,
}: {
  fanout: FanoutMode;
  agentSelection: AgentSelection;
  /** The identity fields, rendered above the rows. */
  children: ReactNode;
}) {
  if (!fanout.isFanout) {
    return children;
  }
  return (
    <>
      {children}
      <FanoutRows rows={fanout.rows} selection={agentSelection} onChange={fanout.setRows} />
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
      <FanoutFields agentSelection={props.agentSelection} fanout={fanout}>
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
          onKeyDown={props.onKeyDown}
          placeholder={promptPlaceholder}
          className="min-h-40"
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
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
