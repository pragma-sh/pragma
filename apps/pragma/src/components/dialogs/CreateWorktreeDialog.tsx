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
import { createWorktree, githubFetchAndSync, githubPullBranch } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

interface CreateWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Structural subset shared by the DOM and React keyboard events the form fields emit. */
type SubmitKeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & {
  preventDefault: () => void;
};

/**
 * Creates a nested worktree and, when a prompt is given, immediately starts an
 * agent session in it: the user names the branch (and an optional display
 * title), picks an agent, optionally writes a markdown prompt, then submits
 * (⌘/Ctrl+↵ or the button). An empty prompt just creates the worktree and opens
 * a terminal in it — no agent session is started.
 */
export function CreateWorktreeDialog({ open: isOpen, onOpenChange }: CreateWorktreeDialogProps) {
  const workspace = useWorkspace();
  const {
    agents,
    modelsByAgent,
    agentId,
    modelSelection,
    selectedAgent,
    loadModels,
    handleAgentChange,
  } = useAgentSelection(isOpen);
  const [branch, setBranch] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [behind, setBehind] = useState(0);
  const [mainWorktreeId, setMainWorktreeId] = useState<string | null>(null);
  const submitShortcut = isMacPlatform() ? "⌘↵" : "Ctrl+↵";
  useEscapeToClose(isOpen, () => onOpenChange(false));

  if (!isOpen) {
    return null;
  }

  const canSubmit = branch.trim().length > 0;

  async function createAndLaunch() {
    const projectId = workspace.selectedProjectId;
    const parentId = workspace.selectedWorktreeId;
    if (!projectId || !parentId) return;
    const worktree = await createWorktree(projectId, parentId, branch, title.trim() || undefined);
    // Load the new worktree into state first so its terminal tab resolves its
    // cwd to the new worktree path.
    await workspace.refreshProject(projectId);
    const prompt = message.trim();
    if (prompt && selectedAgent) {
      rememberModelSelection(selectedAgent.id, modelSelection);
      await workspace.startSession(worktree.id, selectedAgent, prompt, modelSelection);
    } else {
      workspace.selectWorktree(worktree.id);
      await workspace.createTerminalTab(worktree.id);
    }
    onOpenChange(false);
    setBranch("");
    setTitle("");
    setMessage("");
    setError(null);
  }

  async function submit() {
    const projectId = workspace.selectedProjectId;
    if (!projectId || !workspace.selectedWorktreeId || !canSubmit || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const main = (workspace.worktrees[projectId] ?? []).find((worktree) => worktree.isMain);
      if (!main) {
        throw new Error("Project main worktree was not found.");
      }
      const status = await githubFetchAndSync(main.id);
      if (status.behind > 0) {
        setBehind(status.behind);
        setMainWorktreeId(main.id);
        return;
      }
      await createAndLaunch();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmCreate(pullFirst: boolean) {
    if (busy) return;
    const mainId = mainWorktreeId;
    setMainWorktreeId(null);
    setBusy(true);
    setError(null);
    try {
      if (pullFirst && mainId) await githubPullBranch(mainId);
      await createAndLaunch();
    } catch (cause) {
      setError(errorMessage(cause));
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
    <ModalShell className="max-w-2xl">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">New worktree at</h2>
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
            <Button variant="outline" onClick={() => void confirmCreate(false)}>
              Create without syncing
            </Button>
            <AlertDialogAction onClick={() => void confirmCreate(true)}>
              Sync and create
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ModalShell>
  );
}
