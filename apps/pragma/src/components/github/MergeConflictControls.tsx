import { useCallback, useEffect, useRef, useState } from "react";

import type { GitHubRepoRef } from "@pragma-sh/constants";
import { GitCommitHorizontal, Loader2, Sparkles, TriangleAlert } from "lucide-react";
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
    try {
      setPhase("committing");
      const message = await aiCommitMergeResolution(worktreeId, pr.baseRef, pr.headRef);
      setPhase("pushing");
      await githubPushBranch(worktreeId);
      toast.success(`Committed and pushed: ${message.split("\n")[0]}`);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      await refresh();
      setPhase(null);
    }
  }, [onChanged, pr.baseRef, pr.headRef, refresh, worktreeId]);

  return { phase, resolve, commitAndPush };
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

/** The AI action: Resolve Merge Conflicts, or Commit and Push Fixes once nothing is left. */
function AiMergeButton({
  phase,
  readyToCommit,
  disabled,
  onResolve,
  onCommit,
}: {
  phase: AiPhase | null;
  readyToCommit: boolean;
  disabled: boolean;
  onResolve: () => void;
  onCommit: () => void;
}) {
  const idleIcon = readyToCommit ? <GitCommitHorizontal /> : <Sparkles />;
  const idleLabel = readyToCommit ? "Commit and Push Fixes" : "Resolve Merge Conflicts";
  return (
    <Button
      className="w-full"
      disabled={disabled}
      onClick={readyToCommit ? onCommit : onResolve}
      size="sm"
    >
      {phase ? <Loader2 className="animate-spin" /> : idleIcon}
      {phase ? AI_PHASE_LABELS[phase] : idleLabel}
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

/** Whether both built-in AI and a System 1 model are set up. */
function useAiResolutionEnabled(): boolean {
  const { available } = useAi();
  const system1 = useSystem1Status();
  return available && system1?.configured === true;
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
  const aiEnabled = useAiResolutionEnabled();
  const inProgress = status?.inProgress === true;
  const readyToCommit = inProgress && status.unmerged.length === 0;
  const busy = manual.merging || ai.phase !== null || status === null;

  return (
    <>
      <MergeConflictHeader pr={pr} />
      {inProgress && !readyToCommit ? (
        <p className="text-center text-xs font-medium">Resolve the Merge Conflict and Commit</p>
      ) : null}
      {readyToCommit || aiEnabled ? (
        <AiMergeButton
          disabled={busy}
          onCommit={() => void ai.commitAndPush()}
          onResolve={() => void ai.resolve()}
          phase={ai.phase}
          readyToCommit={readyToCommit}
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
