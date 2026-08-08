import { useState } from "react";

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
import { useAgentSelection } from "@/hooks/use-agent-selection";
import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import { rememberModelSelection } from "@/lib/agent-model-selection";
import { errorMessage } from "@/lib/errors";
import { isMacPlatform } from "@/lib/platform";
import { githubFetchAndSync } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";
import { useWorktreeCreation } from "@/state/worktree-creation-context";

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
 * Creates a nested worktree and, when a prompt is given, immediately starts an
 * agent session in it: the user names the branch (and an optional display
 * title), picks an agent, optionally writes a markdown prompt, then submits
 * (⌘/Ctrl+↵ or the button). An empty prompt just creates the worktree and opens
 * a terminal in it — no agent session is started.
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
  const { error, setError, busy, setBusy, behind, setBehind, mainWorktreeId, setMainWorktreeId } =
    useWorktreeSubmission();
  const submitShortcut = isMacPlatform() ? "⌘↵" : "Ctrl+↵";
  useEscapeToClose(isOpen, () => onOpenChange(false));

  if (!isOpen) {
    return null;
  }

  const canSubmit = branch.trim().length > 0;
  const parentId = parentWorktreeId ?? workspace.selectedWorktreeId;
  const parent = (workspace.worktrees[workspace.selectedProjectId ?? ""] ?? []).find(
    (worktree) => worktree.id === parentId,
  );
  const parentLabel = parent?.title?.trim() || parent?.branch || null;

  /**
   * Hands the run off to the background flow and closes immediately: creation
   * (and the optional sync) is reported by the full-frame progress screen, so
   * the modal never blocks the app while it runs.
   */
  function handOff(syncWorktreeId: string | null) {
    const projectId = workspace.selectedProjectId;
    if (!projectId || !parentId) return;
    const prompt = message.trim();
    if (prompt && selectedAgent) {
      rememberModelSelection(selectedAgent.id, modelSelection);
    }
    startCreation({
      projectId,
      parentWorktreeId: parentId,
      branch,
      title: title.trim() || undefined,
      prompt,
      agent: selectedAgent,
      modelSelection,
      syncWorktreeId,
    });
    onOpenChange(false);
    setBranch("");
    setTitle("");
    setMessage("");
    setError(null);
  }

  function canStartSubmit(projectId: string | null): projectId is string {
    return Boolean(projectId && parentId && canSubmit && !busy);
  }

  /** Asks about syncing only when the main worktree is behind the remote. */
  async function checkMainAndCreate(projectId: string) {
    const main = (workspace.worktrees[projectId] ?? []).find((worktree) => worktree.isMain);
    if (!main) {
      throw new Error("Project main worktree was not found.");
    }
    const status = await fetchMainSyncStatus(main.id);
    if (status && status.behind > 0) {
      setBehind(status.behind);
      setMainWorktreeId(main.id);
      return;
    }
    handOff(null);
  }

  async function submit() {
    const projectId = workspace.selectedProjectId;
    if (!canStartSubmit(projectId)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await checkMainAndCreate(projectId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function confirmCreate(pullFirst: boolean) {
    const mainId = mainWorktreeId;
    setMainWorktreeId(null);
    handOff(pullFirst ? mainId : null);
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
    <ModalShell className="max-w-2xl">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">
          {parentLabel ? `New worktree at ${parentLabel}` : "New worktree"}
        </h2>
        <p className="text-sm text-muted-foreground">
          Branches from the selected parent worktree HEAD. Add a prompt to launch an agent session
          in it.
        </p>
      </div>
      <form
        className="mt-5 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="branch">Branch name</Label>
            <Input
              id="branch"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              value={branch}
              onChange={(event) => setBranch(event.target.value.replace(/\s+/g, "-"))}
              onKeyDown={handleKeyDown}
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
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={handleKeyDown}
            />
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
            value={message}
            onChange={setMessage}
            onKeyDown={handleKeyDown}
            placeholder="Describe what you want the agent to do… (leave empty to skip the session)"
            className="min-h-40"
          />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button disabled={busy} type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit || busy}>
            {busy ? "Checking main…" : "Create worktree"}
            <span className="ml-2 text-xs opacity-70">{submitShortcut}</span>
          </Button>
        </div>
      </form>
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setMainWorktreeId(null);
        }}
        open={mainWorktreeId !== null}
      >
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
            <Button variant="outline" onClick={() => confirmCreate(false)}>
              Create without syncing
            </Button>
            <AlertDialogAction onClick={() => confirmCreate(true)}>
              Sync and create
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ModalShell>
  );
}
