import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { GitHubRepoRef } from "@pragma-sh/constants";
import { ArrowUp, GitCommitHorizontal, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

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
import { errorMessage } from "@/lib/errors";
import type { PullRequestSummary } from "@/lib/github";
import {
  aiCommitMergeResolution,
  aiResolveMergeConflicts,
  githubAbortMerge,
  githubMergeBaseBranch,
  githubMergeInProgress,
  githubPushBranch,
  githubUnmergedPaths,
  type MergeConflictResolution,
} from "@/lib/tauri";
import { useAi } from "@/state/ai-context";
import { useSystem1Status } from "@/state/system1";
import { useWorkspace } from "@/state/workspace-context";

/** Where the worktree's merge stands; `null` until the first read resolves. */
interface MergeStatus {
  inProgress: boolean;
  /** Paths still conflicted; empty when every conflict is resolved and staged. */
  unmerged: string[];
}

/** What the AI buttons are doing, shown as their label. */
type AiPhase = "syncing" | "system1" | "verifying" | "committing" | "pushing";

const AI_PHASE_LABELS: Record<AiPhase, string> = {
  syncing: "Syncing with base branch…",
  system1: "Resolving with System 1…",
  verifying: "Verifying results…",
  committing: "Committing fixes…",
  pushing: "Pushing fixes…",
};

/** The fetch/merge remote for a PR whose base lives in another repository (a fork). */
function baseRemoteFor(pr: PullRequestSummary, repo: GitHubRepoRef): string | null {
  return pr.baseRepo && (pr.baseRepo.owner !== repo.owner || pr.baseRepo.repo !== repo.repo)
    ? pr.baseRepo.cloneUrl
    : null;
}

/** Reads the merge state, dropping answers superseded by a newer read. */
function useMergeStatus(worktreeId: string) {
  const [status, setStatus] = useState<MergeStatus | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++request.current;
    try {
      const inProgress = await githubMergeInProgress(worktreeId);
      const unmerged = inProgress ? await githubUnmergedPaths(worktreeId) : [];
      if (current === request.current) setStatus({ inProgress, unmerged });
    } catch (cause) {
      if (current === request.current) toast.error(errorMessage(cause));
    }
  }, [worktreeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, refresh };
}

/** One toast summarizing what the AI did, warning when anything was left for a human. */
function reportResolution(result: MergeConflictResolution): void {
  const resolved = result.files.filter((file) => file.status === "resolved");
  const verified = resolved.filter((file) => file.method === "verified").length;
  const left = result.files.filter((file) => file.status !== "resolved");
  const summary =
    `Resolved ${resolved.length} of ${result.files.length} file` +
    `${result.files.length === 1 ? "" : "s"}` +
    (verified > 0 ? ` (${verified} verified by AI)` : "");
  if (left.length === 0 && result.remaining.length === 0) {
    toast.success(`${summary}. Review the changes, then commit and push.`);
    return;
  }
  const details = left.map((file) => `${file.path}: ${file.reason}`).join("\n");
  toast.warning(`${summary}. Resolve the rest by hand.`, { description: details || undefined });
}

/** The AI resolve → commit and push flow, driving one label through its phases. */
function useAiConflictResolution({
  pr,
  repo,
  worktreeId,
  status,
  refresh,
  onChanged,
}: {
  pr: PullRequestSummary;
  repo: GitHubRepoRef;
  worktreeId: string;
  status: MergeStatus | null;
  refresh: () => Promise<void>;
  onChanged: () => void;
}) {
  const [phase, setPhase] = useState<AiPhase | null>(null);
  /** A merge commit exists locally that has not reached the remote yet. */
  const [unpushed, setUnpushed] = useState(false);

  const resolve = useCallback(async () => {
    try {
      if (!status?.inProgress) {
        setPhase("syncing");
        const conflicts = await githubMergeBaseBranch(
          worktreeId,
          pr.baseRef,
          baseRemoteFor(pr, repo),
        );
        if (!conflicts) {
          toast.success(`Merged latest ${pr.baseRef} and pushed ${pr.headRef}`);
          onChanged();
          return;
        }
      }
      setPhase("system1");
      const result = await aiResolveMergeConflicts(
        worktreeId,
        { title: pr.title, body: pr.body, headRef: pr.headRef, baseRef: pr.baseRef },
        (event) => {
          if (event.phase === "verifying") setPhase("verifying");
        },
      );
      reportResolution(result);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      await refresh();
      setPhase(null);
    }
  }, [onChanged, pr, refresh, repo, status?.inProgress, worktreeId]);

  const commitAndPush = useCallback(async () => {
    let message: string | null = null;
    try {
      if (!unpushed) {
        setPhase("committing");
        message = await aiCommitMergeResolution(worktreeId, pr.baseRef, pr.headRef);
        // The commit is local now: if the push fails, only the push is retried.
        setUnpushed(true);
      }
      setPhase("pushing");
      await githubPushBranch(worktreeId);
      setUnpushed(false);
      toast.success(
        message ? `Committed and pushed: ${message.split("\n")[0]}` : `Pushed ${pr.headRef}`,
      );
      onChanged();
    } catch (cause) {
      const reason = errorMessage(cause);
      toast.error(message ? `Committed, but the push failed: ${reason}` : reason);
    } finally {
      await refresh();
      setPhase(null);
    }
  }, [onChanged, pr.baseRef, pr.headRef, refresh, unpushed, worktreeId]);

  return { phase, unpushed, resolve, commitAndPush };
}

/** Manual sync and abort, independent of the AI flow. */
function useManualMergeActions({
  pr,
  repo,
  worktreeId,
  refresh,
  onChanged,
}: {
  pr: PullRequestSummary;
  repo: GitHubRepoRef;
  worktreeId: string;
  refresh: () => Promise<void>;
  onChanged: () => void;
}) {
  const [merging, setMerging] = useState(false);

  const syncWithBase = useCallback(async () => {
    setMerging(true);
    try {
      const hasConflicts = await githubMergeBaseBranch(
        worktreeId,
        pr.baseRef,
        baseRemoteFor(pr, repo),
      );
      await refresh();
      if (hasConflicts) {
        toast.warning(`Merged ${pr.baseRef}. Resolve conflicting files in this worktree.`);
      } else {
        toast.success(`Merged latest ${pr.baseRef} and pushed ${pr.headRef}`);
        onChanged();
      }
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setMerging(false);
    }
  }, [onChanged, pr, refresh, repo, worktreeId]);

  const abortMerge = useCallback(async () => {
    setMerging(true);
    try {
      await githubAbortMerge(worktreeId);
      await refresh();
      toast.success("Merge aborted and conflict-resolution changes discarded");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setMerging(false);
    }
  }, [refresh, worktreeId]);

  return { merging, syncWithBase, abortMerge };
}

/** What the primary button does next. */
type AiAction = "resolve" | "commit" | "push";

const AI_ACTIONS: Record<AiAction, { icon: ReactNode; label: string }> = {
  resolve: { icon: <Sparkles />, label: "Resolve Merge Conflicts" },
  commit: { icon: <GitCommitHorizontal />, label: "Commit and Push Fixes" },
  push: { icon: <ArrowUp />, label: "Push Fixes" },
};

/** The primary action: Resolve Merge Conflicts, Commit and Push Fixes, or a push-only retry. */
function AiMergeButton({
  action,
  phase,
  disabled,
  onAction,
}: {
  action: AiAction;
  phase: AiPhase | null;
  disabled: boolean;
  onAction: () => void;
}) {
  const { icon, label } = AI_ACTIONS[action];
  return (
    <Button className="w-full" disabled={disabled} onClick={onAction} size="sm">
      {phase ? <Loader2 className="animate-spin" /> : icon}
      {phase ? AI_PHASE_LABELS[phase] : label}
    </Button>
  );
}

function AbortMergeDialog({
  open,
  onOpenChange,
  baseRef,
  onAbort,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baseRef: string;
  onAbort: () => void;
}) {
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Abort merge?</AlertDialogTitle>
          <AlertDialogDescription>
            This will discard all conflict-resolution changes and restore this worktree to its state
            before merging {baseRef}. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onAbort}>Abort merge</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MergeConflictHeader({ pr }: { pr: PullRequestSummary }) {
  return (
    <div className="flex items-start gap-2 text-destructive">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium">Merge conflict</p>
        <p className="text-xs text-muted-foreground">
          This pull request conflicts with {pr.baseRef}. Resolve it by merging latest {pr.baseRef}{" "}
          into {pr.headRef} locally.
        </p>
      </div>
    </div>
  );
}

/**
 * What the AI actions can run. Committing needs built-in AI for the message;
 * resolving also needs a System 1 model. Both inspect the worktree from this
 * machine, so neither is offered for a remote project.
 */
function useAiCapabilities(worktreeId: string): { commit: boolean; resolve: boolean } {
  const { available } = useAi();
  const system1 = useSystem1Status();
  const workspace = useWorkspace();
  const local = workspace.remoteWorktrees[worktreeId] !== true;
  return {
    commit: available && local,
    resolve: available && local && system1?.configured === true,
  };
}

/**
 * The merge-conflict card: sync the base branch in, optionally let System 1
 * (verified by the built-in AI) resolve the conflicts, then commit and push.
 */
export function MergeConflictControls({
  onChanged,
  pr,
  repo,
  worktreeId,
}: {
  onChanged: () => void;
  pr: PullRequestSummary;
  repo: GitHubRepoRef;
  worktreeId: string;
}) {
  const [confirmingAbort, setConfirmingAbort] = useState(false);
  const { status, refresh } = useMergeStatus(worktreeId);
  const ai = useAiConflictResolution({ pr, repo, worktreeId, status, refresh, onChanged });
  const manual = useManualMergeActions({ pr, repo, worktreeId, refresh, onChanged });
  const capabilities = useAiCapabilities(worktreeId);
  const inProgress = status?.inProgress === true;
  const readyToCommit = inProgress && status.unmerged.length === 0;
  const busy = manual.merging || ai.phase !== null || status === null;
  const action: AiAction = ai.unpushed ? "push" : readyToCommit ? "commit" : "resolve";
  const actionAvailable = action === "push" || capabilities[action];

  return (
    <>
      <MergeConflictHeader pr={pr} />
      {inProgress && !readyToCommit ? (
        <p className="text-center text-xs font-medium">Resolve the Merge Conflict and Commit</p>
      ) : null}
      {action === "commit" && !actionAvailable ? (
        <p className="text-center text-xs font-medium">
          Conflicts resolved. Commit the merge, then push {pr.headRef}.
        </p>
      ) : null}
      {actionAvailable ? (
        <AiMergeButton
          action={action}
          disabled={busy}
          onAction={() => void (action === "resolve" ? ai.resolve() : ai.commitAndPush())}
          phase={ai.phase}
        />
      ) : null}
      <Button
        className="w-full"
        disabled={busy}
        onClick={() => (inProgress ? setConfirmingAbort(true) : void manual.syncWithBase())}
        size="sm"
        variant="destructive"
      >
        {manual.merging || status === null ? <Loader2 className="animate-spin" /> : null}
        {inProgress ? "Abort Merge" : "Sync with Base Branch"}
      </Button>
      <AbortMergeDialog
        baseRef={pr.baseRef}
        onAbort={() => {
          setConfirmingAbort(false);
          void manual.abortMerge();
        }}
        onOpenChange={setConfirmingAbort}
        open={confirmingAbort}
      />
    </>
  );
}
