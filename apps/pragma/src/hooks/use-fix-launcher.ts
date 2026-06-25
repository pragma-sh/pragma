import { useState } from "react";

import { type AgentSelection, useAgentSelection } from "@/hooks/use-agent-selection";
import { rememberModelSelection } from "@/lib/agent-model-selection";
import { createWorktree } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The optional "fix on a fresh worktree" branch + title, mirroring the New-worktree form. */
export interface NewWorktreeOption {
  enabled: boolean;
  branch: string;
  title: string;
}

/**
 * Shared brain for the "fix a review comment" dialogs: picks an agent + model,
 * optionally creates a new worktree to fix on (same fields as New worktree), and
 * launches an agent session seeded with a prompt. Either runs on the review tab's
 * own `worktreeId` or branches a new worktree from it.
 */
export interface FixLauncher {
  selection: AgentSelection;
  newWorktree: NewWorktreeOption;
  setNewWorktreeEnabled: (enabled: boolean) => void;
  setBranch: (branch: string) => void;
  setTitle: (title: string) => void;
  busy: boolean;
  error: string | null;
  /** Whether `launch` can run: an agent is chosen and (if branching) a branch is named. */
  canLaunch: boolean;
  /** Launches the agent with `prompt`; resolves `true` on success, `false` otherwise. */
  launch: (prompt: string) => Promise<boolean>;
}

export function useFixLauncher(active: boolean, worktreeId: string): FixLauncher {
  const workspace = useWorkspace();
  const selection = useAgentSelection(active);
  const [enabled, setEnabled] = useState(false);
  const [branch, setBranch] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canLaunch =
    selection.selectedAgent !== null && (!enabled || branch.trim().length > 0) && !busy;

  async function launch(prompt: string): Promise<boolean> {
    const agent = selection.selectedAgent;
    if (!agent || !prompt.trim() || busy) {
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      rememberModelSelection(agent.id, selection.modelSelection);
      if (enabled) {
        const projectId = workspace.selectedProjectId;
        if (!projectId) {
          throw new Error("No project is selected to create a worktree in.");
        }
        const trimmedBranch = branch.trim();
        if (!trimmedBranch) {
          throw new Error("Enter a branch name for the new worktree.");
        }
        const worktree = await createWorktree(
          projectId,
          worktreeId,
          trimmedBranch,
          title.trim() || undefined,
        );
        // Load the new worktree into state so its terminal tab resolves its cwd.
        await workspace.refreshProject(projectId);
        await workspace.startSession(worktree.id, agent, prompt, selection.modelSelection);
      } else {
        await workspace.startSession(worktreeId, agent, prompt, selection.modelSelection);
      }
      return true;
    } catch (cause) {
      setError(messageFor(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return {
    selection,
    newWorktree: { enabled, branch, title },
    setNewWorktreeEnabled: setEnabled,
    setBranch,
    setTitle,
    busy,
    error,
    canLaunch,
    launch,
  };
}
