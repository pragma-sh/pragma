import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "@/lib/errors";

import type { ChangedFile, GitHubRepoRef } from "@pragma/constants";
import { Icon } from "@iconify/react";
import { CheckCircle2, CircleDot, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";

import { GitHubMarkdown } from "@/components/github/GitHubMarkdown";
import { MarkdownEditor } from "@/components/github/MarkdownEditor";
import { ChangeGroup } from "@/components/right-sidebar/ChangeGroup";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type ChecksStatus,
  type GitHubActor,
  type IssueComment,
  type PullFile,
  type PullRequestSummary,
  type ReviewThread,
  createIssueComment,
  getChecksStatus,
  listIssueComments,
  listPullFiles,
  listReviewThreads,
  mergePullRequest,
} from "@/lib/github";
import { browserOpenExternal, githubDeleteRemoteBranch } from "@/lib/tauri";
import { requestReviewFocus } from "@/state/review-focus-store";
import { useWorkspace } from "@/state/workspace-context";

/** Maps a GitHub PR file status to the worktree `ChangeStatus` the row renderer expects. */
function toChangeStatus(status: string): ChangedFile["status"] {
  switch (status) {
    case "added":
    case "copied":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

/** Adapts a PR file to `ChangedFile` so the Changes `ChangeGroup` can render it. */
function toChangedFile(file: PullFile): ChangedFile {
  return {
    path: file.path,
    oldPath: file.oldPath,
    status: toChangeStatus(file.status),
    side: "committed",
    additions: file.additions,
    deletions: file.deletions,
  };
}

interface PullData {
  comments: IssueComment[];
  files: PullFile[];
  threads: ReviewThread[];
  checks: ChecksStatus;
}

/** Loads the PR's comments, files, review threads, and checks. */
function usePullRequestData(repo: GitHubRepoRef, pr: PullRequestSummary) {
  const [data, setData] = useState<PullData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);

  const load = useCallback(async () => {
    try {
      const [comments, files, threads, checks] = await Promise.all([
        listIssueComments(repo, pr.number),
        listPullFiles(repo, pr.number),
        listReviewThreads(repo, pr.number),
        getChecksStatus(repo, pr.headSha),
      ]);
      if (active.current) {
        setData({ comments, files, threads, checks });
      }
    } catch (cause) {
      if (active.current) {
        setError(errorMessage(cause));
      }
    }
  }, [repo, pr.number, pr.headSha]);

  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
    };
  }, [load]);

  return { data, error, load };
}

/** path → count of unresolved review threads, for the per-file badge. */
function useUnresolvedByPath(threads: ReviewThread[] | undefined) {
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads ?? []) {
      if (!thread.isResolved) {
        counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
      }
    }
    return counts;
  }, [threads]);
}

/** The read-only conversation: error / loading / empty / comment cards. */
function Conversation({
  comments,
  error,
}: {
  comments: IssueComment[] | null;
  error: string | null;
}) {
  let body: React.ReactNode;
  if (error) {
    body = <p className="text-xs text-destructive">{error}</p>;
  } else if (!comments) {
    body = <p className="text-xs text-muted-foreground">Loading…</p>;
  } else if (comments.length === 0) {
    body = <p className="text-xs text-muted-foreground">No comments yet.</p>;
  } else {
    body = comments.map((comment) => <CommentCard comment={comment} key={comment.id} />);
  }
  return (
    <section className="flex flex-col gap-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Conversation</p>
      {body}
    </section>
  );
}

/** The files-changed list; each row opens the review tab focused on that file. */
function ChangedFilesSection({
  changedFiles,
  prNumber,
  unresolvedByPath,
  workspace,
}: {
  changedFiles: ChangedFile[];
  prNumber: number;
  unresolvedByPath: Map<string, number>;
  workspace: ReturnType<typeof useWorkspace>;
}) {
  return (
    <section className="flex flex-col gap-1">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Files changed</p>
      <ChangeGroup
        emptyLabel="No files changed"
        // oxlint-disable-next-line react/no-unstable-nested-components -- render prop, not a nested component definition; UnresolvedBadge is declared at module scope.
        fileBadge={(file) => <UnresolvedBadge count={unresolvedByPath.get(file.path) ?? 0} />}
        files={changedFiles}
        onOpen={(file) => {
          // Request the scroll first so the review tab (new or already open)
          // jumps to this file once its sections are mounted.
          requestReviewFocus(prNumber, file.path);
          void workspace.openReviewTab(prNumber, `Review #${prNumber}`);
        }}
        title={`${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}`}
      />
    </section>
  );
}

/** The merge card for open PRs, or a merged/closed status line otherwise. */
function MergeOrStatus({
  checks,
  onChanged,
  pr,
  repo,
  worktreeId,
}: {
  checks: ChecksStatus | null;
  onChanged: () => void;
  pr: PullRequestSummary;
  repo: GitHubRepoRef;
  worktreeId: string;
}) {
  if (!pr.merged && pr.state === "open") {
    return (
      <MergeCard
        checks={checks}
        onChanged={onChanged}
        pr={pr}
        repo={repo}
        worktreeId={worktreeId}
      />
    );
  }
  return (
    <p className="rounded-md border border-border bg-canvas px-3 py-2 text-xs text-muted-foreground">
      {pr.merged ? "This pull request has been merged." : "This pull request is closed."}
    </p>
  );
}

/**
 * The view state of an open (or merged) pull request: a header card (title +
 * number, an open-on-GitHub icon button, state, base ← head, markdown body), the
 * read-only conversation, the changed-files list (reusing `ChangeGroup`, each
 * row opening the review tab and badged with its unresolved-comment count), and
 * the merge card (checks summary + merge → branch-cleanup flow).
 */
export function ViewPullRequestView({
  repo,
  pr,
  worktreeId,
  onChanged,
}: {
  repo: GitHubRepoRef;
  pr: PullRequestSummary;
  worktreeId: string;
  onChanged: () => void;
}) {
  const workspace = useWorkspace();
  const { data, error, load } = usePullRequestData(repo, pr);
  const unresolvedByPath = useUnresolvedByPath(data?.threads);
  const changedFiles = useMemo(() => (data?.files ?? []).map(toChangedFile), [data?.files]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 text-sm">
      <HeaderCard pr={pr} />
      <Conversation comments={data?.comments ?? null} error={error} />
      <ChangedFilesSection
        changedFiles={changedFiles}
        prNumber={pr.number}
        unresolvedByPath={unresolvedByPath}
        workspace={workspace}
      />
      <CommentBox onPosted={() => void load()} prNumber={pr.number} repo={repo} />
      <MergeOrStatus
        checks={data?.checks ?? null}
        onChanged={onChanged}
        pr={pr}
        repo={repo}
        worktreeId={worktreeId}
      />
    </div>
  );
}

/** The per-file unresolved-comment count badge in the files-changed list. */
function UnresolvedBadge({ count }: { count: number }) {
  if (count <= 0) {
    return null;
  }
  return (
    <span className="shrink-0 rounded bg-warning/20 px-1 text-[10px] text-warning">{count}</span>
  );
}

/** Title + number, open-on-GitHub icon, state badge, base ← head chips, markdown body. */
function HeaderCard({ pr }: { pr: PullRequestSummary }) {
  const stateLabel = pr.merged ? "merged" : pr.draft ? "draft" : pr.state;
  const stateClass = pr.merged
    ? "bg-skill/20 text-skill"
    : pr.draft
      ? "bg-muted text-muted-foreground"
      : pr.state === "open"
        ? "bg-success/20 text-success"
        : "bg-destructive/20 text-destructive";
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-canvas p-3">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-lg leading-snug font-semibold text-foreground">
          {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
        </h2>
        <Button
          aria-label="Open on GitHub"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => void browserOpenExternal(pr.htmlUrl)}
          size="icon-sm"
          title="Open on GitHub"
          variant="ghost"
        >
          <Icon className="size-4" icon="simple-icons:github" />
        </Button>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${stateClass}`}>
          {stateLabel}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{pr.baseRef}</span>
        <span>←</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{pr.headRef}</span>
      </div>
      <div className="rounded-md border border-border bg-canvas p-2">
        <GitHubMarkdown>{pr.body}</GitHubMarkdown>
      </div>
    </div>
  );
}

/** Formats an ISO timestamp as `mm/dd/yy` for a comment footer (empty if unparseable). */
function formatCommentDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "2-digit" });
}

/**
 * A read-only conversation comment styled like a GitHub comment: an avatar beside
 * a bordered "bubble" whose header strip names the author and whose body holds the
 * markdown, the date tucked into the bottom-right corner, with a little arrow tying
 * the bubble back to the avatar.
 */
function CommentCard({ comment }: { comment: IssueComment }) {
  const when = formatCommentDate(comment.createdAt);
  return (
    <div className="flex gap-2">
      <ActorAvatar actor={comment.user} />
      <div className="relative min-w-0 flex-1 rounded-md border border-border bg-canvas">
        {/* Arrow connecting the bubble to the avatar, GitHub-style. */}
        <span className="absolute top-2.5 -left-[5px] size-2 rotate-45 border-b border-l border-border bg-muted/30" />
        <div className="rounded-t-md border-b border-border bg-muted/30 px-3 py-1.5 text-xs">
          <span className="font-semibold text-muted-foreground">
            {comment.user?.login ?? "ghost"}
          </span>
        </div>
        <div className="px-3 py-2">
          <GitHubMarkdown>{comment.body}</GitHubMarkdown>
        </div>
        {when ? (
          <span className="block px-3 pb-1.5 text-right text-[10px] text-muted-foreground">
            {when}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The markdown comment composer pinned below the conversation: a TipTap editor
 * whose markdown is posted as an issue comment on the signed-in user's behalf.
 * Submits on click or ⌘/Ctrl+Enter, clears on success, and asks the parent to
 * reload so the new comment joins the conversation.
 */
function CommentBox({
  repo,
  prNumber,
  onPosted,
}: {
  repo: GitHubRepoRef;
  prNumber: number;
  onPosted: () => void;
}) {
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed || posting) {
      return;
    }
    setPosting(true);
    try {
      await createIssueComment(repo, prNumber, trimmed);
      setBody("");
      onPosted();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setPosting(false);
    }
  }, [body, posting, repo, prNumber, onPosted]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  return (
    <section className="flex flex-col gap-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Add a comment</p>
      <MarkdownEditor
        onChange={setBody}
        onKeyDown={onKeyDown}
        placeholder="Leave a comment…"
        value={body}
      />
      <div className="flex justify-end">
        <Button
          disabled={posting || body.trim().length === 0}
          onClick={() => void submit()}
          size="sm"
        >
          {posting ? <Loader2 className="animate-spin" /> : null}
          Comment
        </Button>
      </div>
    </section>
  );
}

/** Small round avatar for a GitHub actor, falling back to the login initial. */
export function ActorAvatar({ actor }: { actor: GitHubActor | null }) {
  return (
    <Avatar className="size-6 shrink-0">
      {actor ? <AvatarImage alt={actor.login} src={actor.avatarUrl} /> : null}
      <AvatarFallback className="text-[10px]">
        {(actor?.login ?? "?").slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/** Checks summary + Merge button → confirm → branch-cleanup dialog. */
function MergeCard({
  checks,
  pr,
  repo,
  worktreeId,
  onChanged,
}: {
  checks: ChecksStatus | null;
  pr: PullRequestSummary;
  repo: GitHubRepoRef;
  worktreeId: string;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [cleanup, setCleanup] = useState(false);

  const merge = useCallback(async () => {
    setConfirming(false);
    setMerging(true);
    try {
      await mergePullRequest(repo, pr.number);
      toast.success(`Merged pull request #${pr.number}`);
      setCleanup(true);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setMerging(false);
    }
  }, [repo, pr.number]);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-canvas p-3">
      <ChecksSummary checks={checks} />
      <Button
        className="w-full"
        disabled={merging || pr.mergeable === false}
        onClick={() => setConfirming(true)}
        size="sm"
      >
        {merging ? <Loader2 className="animate-spin" /> : null}
        {pr.mergeable === false ? "Cannot merge (conflicts)" : "Merge pull request"}
      </Button>

      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge pull request?</AlertDialogTitle>
            <AlertDialogDescription>
              {pr.headRef} will be merged into {pr.baseRef} with a merge commit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void merge()}>Merge</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <BranchCleanupDialog
        onChanged={onChanged}
        onOpenChange={setCleanup}
        open={cleanup}
        pr={pr}
        worktreeId={worktreeId}
      />
    </div>
  );
}

/** Renders the combined checks state as the merge-card summary line. */
function ChecksSummary({ checks }: { checks: ChecksStatus | null }) {
  if (!checks || checks.state === "none") {
    return <p className="text-xs text-muted-foreground">No checks reported.</p>;
  }
  if (checks.state === "success") {
    return (
      <p className="inline-flex items-center gap-1 text-xs text-success">
        <CheckCircle2 className="size-4" /> All {checks.total} checks passed
      </p>
    );
  }
  if (checks.state === "failure") {
    return (
      <p className="inline-flex items-center gap-1 text-xs text-destructive">
        <XCircle className="size-4" /> {checks.failed} of {checks.total} checks failed
      </p>
    );
  }
  return (
    <p className="inline-flex items-center gap-1 text-xs text-warning">
      <CircleDot className="size-4" /> {checks.passed}/{checks.total} checks complete
    </p>
  );
}

/**
 * Post-merge cleanup: a checkbox to also delete the remote branch, then deletes
 * the worktree + local branch (`deleteWorktree(deleteBranch: true)`) and, when
 * checked, the `origin` branch. Closing without confirming leaves everything.
 */
function BranchCleanupDialog({
  open,
  onOpenChange,
  pr,
  worktreeId,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pr: PullRequestSummary;
  worktreeId: string;
  onChanged: () => void;
}) {
  const workspace = useWorkspace();
  const [deleteRemote, setDeleteRemote] = useState(true);
  const [working, setWorking] = useState(false);

  const cleanup = useCallback(async () => {
    setWorking(true);
    try {
      if (deleteRemote) {
        await githubDeleteRemoteBranch(worktreeId);
      }
      await workspace.deleteWorktree(worktreeId, { deleteBranch: true, force: true });
      toast.success("Cleaned up merged branch");
      onOpenChange(false);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }, [deleteRemote, worktreeId, workspace, onOpenChange, onChanged]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Clean up branch</DialogTitle>
          <DialogDescription>
            #{pr.number} is merged. Delete the worktree and its local branch
            {deleteRemote ? ", and the remote branch" : ""}?
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={deleteRemote}
            onCheckedChange={(value) => setDeleteRemote(value === true)}
          />
          Also delete the remote branch ({pr.headRef})
        </label>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="outline">
            Keep
          </Button>
          <Button disabled={working} onClick={() => void cleanup()} size="sm" variant="destructive">
            {working ? <Loader2 className="animate-spin" /> : null}
            Delete branch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
