import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "@/lib/errors";

import type { ChangedFile, GitHubRepoRef, Worktree } from "@pragma/constants";
import { Icon } from "@iconify/react";
import {
  Check,
  CheckCircle2,
  ChevronUp,
  CircleDot,
  Loader2,
  TriangleAlert,
  X,
  XCircle,
} from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  type CheckStatusItem,
  type GitHubActor,
  type IssueComment,
  type PullFile,
  type PullRequestSummary,
  type PullRequestCommit,
  type ReviewThread,
  createIssueComment,
  getChecksStatus,
  listIssueComments,
  listPullRequestCommits,
  listPullFiles,
  listReviewThreads,
  getPullRequestStack,
  mergePullRequest,
  mergePullRequestStack,
} from "@/lib/github";
import {
  browserOpenExternal,
  githubAbortMerge,
  githubDeleteRemoteBranch,
  githubMergeBaseBranch,
  githubMergeInProgress,
} from "@/lib/tauri";
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
  commits: PullRequestCommit[];
  files: PullFile[];
  threads: ReviewThread[];
  checks: ChecksStatus;
}

/** Loads the PR's conversation, files, review threads, and checks (cached + parallel). */
function usePullRequestData(repo: GitHubRepoRef, pr: PullRequestSummary) {
  const [data, setData] = useState<PullData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const hasData = useRef(false);
  // Comments posted before the initial load resolves — merged in once real data arrives,
  // instead of fabricating empty commits/files/threads/checks for an in-flight PR.
  const pendingOptimistic = useRef<Map<number, IssueComment>>(new Map());

  const load = useCallback(
    async (force = false) => {
      try {
        const [comments, commits, files, threads, checks] = await Promise.all([
          listIssueComments(repo, pr.number, { force }),
          listPullRequestCommits(repo, pr.number, { force }),
          listPullFiles(repo, pr.number, { force }),
          listReviewThreads(repo, pr.number, { force }),
          getChecksStatus(repo, pr.headSha, { force }),
        ]);
        if (active.current) {
          hasData.current = true;
          const known = new Set(comments.map((entry) => entry.id));
          const stillPending = [...pendingOptimistic.current.values()].filter(
            (entry) => !known.has(entry.id),
          );
          setData({
            comments: stillPending.length > 0 ? [...comments, ...stillPending] : comments,
            commits,
            files,
            threads,
            checks,
          });
          setError(null);
        }
      } catch (cause) {
        // Keep prior data on screen when a background refresh fails.
        if (active.current && !hasData.current) {
          setError(errorMessage(cause));
        }
      }
    },
    [repo, pr.number, pr.headSha],
  );

  useEffect(() => {
    active.current = true;
    hasData.current = false;
    pendingOptimistic.current.clear();
    void load(false);
    return () => {
      active.current = false;
    };
  }, [load]);

  /** Append a just-posted comment optimistically (real id replaces temp on success). */
  const prependComment = useCallback((comment: IssueComment) => {
    pendingOptimistic.current.set(comment.id, comment);
    setData((prev) => {
      if (!prev) {
        // Initial load hasn't resolved yet — held in pendingOptimistic and merged in by load().
        return prev;
      }
      if (prev.comments.some((entry) => entry.id === comment.id)) {
        return prev;
      }
      return { ...prev, comments: [...prev.comments, comment] };
    });
  }, []);

  const removeComment = useCallback((commentId: number) => {
    pendingOptimistic.current.delete(commentId);
    setData((prev) => {
      if (!prev) return prev;
      return { ...prev, comments: prev.comments.filter((entry) => entry.id !== commentId) };
    });
  }, []);

  return { data, error, load, prependComment, removeComment };
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

type ConversationItem =
  | { kind: "comment"; timestamp: string; value: IssueComment }
  | { kind: "commit"; timestamp: string; value: PullRequestCommit };

/** Combines PR conversation events in their GitHub-visible chronological order. */
function conversationItems(
  comments: IssueComment[],
  commits: PullRequestCommit[],
): ConversationItem[] {
  return [
    ...comments.map(
      (comment): ConversationItem => ({
        kind: "comment",
        timestamp: comment.createdAt,
        value: comment,
      }),
    ),
    ...commits.map(
      (commit): ConversationItem => ({
        kind: "commit",
        timestamp: commit.committedAt,
        value: commit,
      }),
    ),
  ].toSorted((left, right) => left.timestamp.localeCompare(right.timestamp));
}

/** The read-only conversation: error / loading / empty / comment and commit events. */
function Conversation({
  comments,
  commits,
  error,
}: {
  comments: IssueComment[] | null;
  commits: PullRequestCommit[] | null;
  error: string | null;
}) {
  let body: React.ReactNode;
  if (error) {
    body = <p className="text-xs text-destructive">{error}</p>;
  } else if (!comments || !commits) {
    body = <p className="text-xs text-muted-foreground">Loading…</p>;
  } else if (comments.length === 0 && commits.length === 0) {
    body = <p className="text-xs text-muted-foreground">No activity yet.</p>;
  } else {
    body = conversationItems(comments, commits).map((item) =>
      item.kind === "comment" ? (
        <CommentCard comment={item.value} key={`comment-${item.value.id}`} />
      ) : (
        <CommitCard commit={item.value} key={`commit-${item.value.sha}`} />
      ),
    );
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
  onMergingChange,
  pr,
  repo,
  worktreeId,
}: {
  checks: ChecksStatus | null;
  onChanged: () => void;
  onMergingChange?: (merging: boolean) => void;
  pr: PullRequestSummary;
  repo: GitHubRepoRef;
  worktreeId: string;
}) {
  if (!pr.merged && pr.state === "open") {
    return (
      <MergeCard
        checks={checks}
        onChanged={onChanged}
        onMergingChange={onMergingChange}
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
  merging = false,
}: {
  repo: GitHubRepoRef;
  pr: PullRequestSummary;
  worktreeId: string;
  onChanged: () => void;
  /** True while a merge mutation is in flight (shows the "merging" badge). */
  merging?: boolean;
}) {
  const workspace = useWorkspace();
  const { data, error, load, prependComment, removeComment } = usePullRequestData(repo, pr);
  const unresolvedByPath = useUnresolvedByPath(data?.threads);
  const changedFiles = useMemo(() => (data?.files ?? []).map(toChangedFile), [data?.files]);
  const [localMerging, setLocalMerging] = useState(false);
  const showMerging = merging || localMerging;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 text-sm">
      <HeaderCard merging={showMerging} pr={pr} />
      <Conversation
        comments={data?.comments ?? null}
        commits={data?.commits ?? null}
        error={error}
      />
      <ChangedFilesSection
        changedFiles={changedFiles}
        prNumber={pr.number}
        unresolvedByPath={unresolvedByPath}
        workspace={workspace}
      />
      <CommentBox
        onOptimistic={prependComment}
        onOptimisticRevert={removeComment}
        onPosted={() => void load(true)}
        prNumber={pr.number}
        repo={repo}
      />
      <MergeOrStatus
        checks={data?.checks ?? null}
        onChanged={onChanged}
        onMergingChange={setLocalMerging}
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

/** Title chip label + class for the PR header state badge. */
function prHeaderBadge(
  pr: PullRequestSummary,
  merging: boolean,
): { label: string; className: string } {
  if (merging) return { label: "merging", className: "bg-warning/20 text-warning" };
  if (pr.merged) return { label: "merged", className: "bg-skill/20 text-skill" };
  if (pr.draft) return { label: "draft", className: "bg-muted text-muted-foreground" };
  if (pr.state === "open") return { label: pr.state, className: "bg-success/20 text-success" };
  return { label: pr.state, className: "bg-destructive/20 text-destructive" };
}

/** Title + number, open-on-GitHub icon, state badge, base ← head chips, markdown body. */
function HeaderCard({ pr, merging = false }: { pr: PullRequestSummary; merging?: boolean }) {
  const { label: stateLabel, className: stateClass } = prHeaderBadge(pr, merging);
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
      <GitHubMarkdown>{pr.body}</GitHubMarkdown>
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

/** One clickable commit log entry, arranged like GitHub's PR timeline event. */
function CommitCard({ commit }: { commit: PullRequestCommit }) {
  const status =
    commit.status === "success" ? (
      <Check aria-label="Checks passed" className="size-4 text-success" />
    ) : commit.status === "failure" ? (
      <X aria-label="Checks failed" className="size-4 text-destructive" />
    ) : commit.status === "pending" ? (
      <CircleDot aria-label="Checks pending" className="size-4 text-warning" />
    ) : null;

  return (
    <button
      className="group flex w-full items-center gap-2 rounded-md border border-transparent px-1 py-1.5 text-left hover:border-border hover:bg-muted/30"
      onClick={() => void browserOpenExternal(commit.url)}
      title="Open commit diff on GitHub"
      type="button"
    >
      <div className="flex shrink-0 -space-x-1.5">
        {commit.authors.map((author, index) => (
          <CommitAuthorAvatar
            author={author}
            index={index}
            key={`${author.name}-${author.user?.login ?? index}`}
          />
        ))}
      </div>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground underline-offset-2 group-hover:underline">
        {commit.message}
      </span>
      {status ? (
        <span className="shrink-0" title={`Checks ${commit.status}`}>
          {status}
        </span>
      ) : null}
      <span className="shrink-0 font-mono text-xs text-muted-foreground underline-offset-2 group-hover:underline">
        {commit.sha.slice(0, 7)}
      </span>
    </button>
  );
}

/** Compact overlapping author avatars, including co-authors from the commit trailer. */
function CommitAuthorAvatar({
  author,
  index,
}: {
  author: PullRequestCommit["authors"][number];
  index: number;
}) {
  return (
    <Avatar
      className="size-5 border border-background"
      style={{ zIndex: 10 - index }}
      title={author.user?.login ?? author.name}
    >
      {author.user ? <AvatarImage alt={author.user.login} src={author.user.avatarUrl} /> : null}
      <AvatarFallback className="text-[8px]">
        {author.name.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * The markdown comment composer pinned below the conversation: a TipTap editor
 * whose markdown is posted as an issue comment on the signed-in user's behalf.
 * Submits on click or ⌘/Ctrl+Enter. The comment lands in the conversation
 * **optimistically** (temp negative id) and is replaced by the real one on
 * success; a failed post reverts the optimistic row and toasts.
 */
function CommentBox({
  repo,
  prNumber,
  onPosted,
  onOptimistic,
  onOptimisticRevert,
}: {
  repo: GitHubRepoRef;
  prNumber: number;
  onPosted: () => void;
  onOptimistic: (comment: IssueComment) => void;
  onOptimisticRevert: (commentId: number) => void;
}) {
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const tempId = useRef(-1);

  const submit = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed || posting) {
      return;
    }
    setPosting(true);
    const optimisticId = tempId.current--;
    const optimistic: IssueComment = {
      id: optimisticId,
      body: trimmed,
      htmlUrl: "",
      createdAt: new Date().toISOString(),
      user: null,
    };
    onOptimistic(optimistic);
    setBody("");
    try {
      const posted = await createIssueComment(repo, prNumber, trimmed);
      onOptimisticRevert(optimisticId);
      onOptimistic(posted);
      onPosted();
    } catch (cause) {
      onOptimisticRevert(optimisticId);
      setBody(trimmed);
      toast.error(errorMessage(cause));
    } finally {
      setPosting(false);
    }
  }, [body, posting, repo, prNumber, onPosted, onOptimistic, onOptimisticRevert]);

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
  onMergingChange,
}: {
  checks: ChecksStatus | null;
  pr: PullRequestSummary;
  repo: GitHubRepoRef;
  worktreeId: string;
  onChanged: () => void;
  onMergingChange?: (merging: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [cleanup, setCleanup] = useState(false);
  const [stack, setStack] = useState<Awaited<ReturnType<typeof getPullRequestStack>> | undefined>(
    undefined,
  );
  const workspace = useWorkspace();

  useEffect(() => {
    let active = true;
    void getPullRequestStack(repo, pr.number)
      .then((loadedStack) => {
        if (active) setStack(loadedStack);
        return loadedStack;
      })
      .catch(() => {
        if (active) setStack(undefined);
      });
    return () => {
      active = false;
    };
  }, [pr.number, repo]);

  const merge = useCallback(async () => {
    if (stack === undefined) {
      toast.error("Stack membership is still loading.");
      return;
    }
    setConfirming(false);
    setMerging(true);
    onMergingChange?.(true);
    try {
      if (stack) {
        await mergePullRequestStack(repo, stack);
        toast.success(`Merged stack #${stack.number}`);
      } else {
        await mergePullRequest(repo, pr.number);
        toast.success(`Merged pull request #${pr.number}`);
      }
      setCleanup(true);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setMerging(false);
      onMergingChange?.(false);
    }
  }, [repo, pr.number, onChanged, onMergingChange, stack]);

  const cleanupTargets = useMemo(
    () => stackCleanupTargets(stack ?? null, pr, worktreeId, workspace.worktrees),
    [pr, stack, workspace.worktrees, worktreeId],
  );

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-canvas p-3">
      {pr.mergeable === false ? (
        <MergeConflictControls onChanged={onChanged} pr={pr} repo={repo} worktreeId={worktreeId} />
      ) : (
        <>
          <ChecksSummary checks={checks} />
          <Button
            className="w-full"
            disabled={merging || stack === undefined}
            onClick={() => setConfirming(true)}
            size="sm"
          >
            {merging ? <Loader2 className="animate-spin" /> : null}
            {stack === undefined
              ? "Checking stack membership…"
              : stack
                ? "Merge stack"
                : "Merge pull request"}
          </Button>
          {stack === undefined ? (
            <p className="text-xs text-muted-foreground">
              Merge stays disabled until GitHub confirms stack membership.
            </p>
          ) : null}
        </>
      )}

      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{stack ? "Merge stack?" : "Merge pull request?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {stack
                ? `${stack.entries.length} pull requests will be merged from top to bottom.`
                : `${pr.headRef} will be merged into ${pr.baseRef} with a merge commit.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void merge()}>
              {stack ? "Merge stack" : "Merge"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <BranchCleanupDialog
        onChanged={onChanged}
        onOpenChange={setCleanup}
        open={cleanup}
        targets={cleanupTargets}
      />
    </div>
  );
}

interface BranchCleanupTarget {
  prNumber: number;
  headRef: string;
  worktreeId: string;
}

/** Resolves stack branches to unique worktrees in the current project, top first. */
function stackCleanupTargets(
  stack: Awaited<ReturnType<typeof getPullRequestStack>>,
  pr: PullRequestSummary,
  worktreeId: string,
  worktreesByProject: Record<string, Worktree[]>,
): BranchCleanupTarget[] {
  if (!stack) return [{ prNumber: pr.number, headRef: pr.headRef, worktreeId }];
  const current = Object.values(worktreesByProject)
    .flat()
    .find((worktree) => worktree.id === worktreeId);
  const project = current ? (worktreesByProject[current.projectId] ?? []) : [];
  return stack.entries.toReversed().flatMap((entry) => {
    if (entry.number === pr.number) {
      return [{ prNumber: entry.number, headRef: entry.headRef, worktreeId }];
    }
    const matches = project.filter((worktree) => worktree.branch === entry.headRef);
    return matches.length === 1
      ? [{ prNumber: entry.number, headRef: entry.headRef, worktreeId: matches[0]!.id }]
      : [];
  });
}

function MergeConflictControls({
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
  const [merging, setMerging] = useState(false);
  const [mergeInProgress, setMergeInProgress] = useState<boolean | null>(null);
  const [confirmingAbort, setConfirmingAbort] = useState(false);
  const mergeStatusRequest = useRef(0);

  const refreshMergeStatus = useCallback(async () => {
    const request = ++mergeStatusRequest.current;
    try {
      const status = await githubMergeInProgress(worktreeId);
      if (request === mergeStatusRequest.current) {
        setMergeInProgress(status);
      }
    } catch (cause) {
      if (request === mergeStatusRequest.current) {
        toast.error(errorMessage(cause));
      }
    }
  }, [worktreeId]);

  useEffect(() => {
    void refreshMergeStatus();
  }, [refreshMergeStatus]);

  const resolveConflicts = useCallback(async () => {
    setMerging(true);
    try {
      const baseRemote =
        pr.baseRepo && (pr.baseRepo.owner !== repo.owner || pr.baseRepo.repo !== repo.repo)
          ? pr.baseRepo.cloneUrl
          : null;
      const hasConflicts = await githubMergeBaseBranch(worktreeId, pr.baseRef, baseRemote);
      await refreshMergeStatus();
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
  }, [
    onChanged,
    pr.baseRef,
    pr.baseRepo,
    pr.headRef,
    refreshMergeStatus,
    repo.owner,
    repo.repo,
    worktreeId,
  ]);

  const abortMerge = useCallback(async () => {
    setConfirmingAbort(false);
    setMerging(true);
    try {
      await githubAbortMerge(worktreeId);
      await refreshMergeStatus();
      toast.success("Merge aborted and conflict-resolution changes discarded");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setMerging(false);
    }
  }, [refreshMergeStatus, worktreeId]);

  return (
    <>
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
      {mergeInProgress ? (
        <p className="text-center text-xs font-medium">Resolve the Merge Conflict and Commit</p>
      ) : null}
      <Button
        className="w-full"
        disabled={merging || mergeInProgress === null}
        onClick={() => (mergeInProgress ? setConfirmingAbort(true) : void resolveConflicts())}
        size="sm"
        variant="destructive"
      >
        {merging || mergeInProgress === null ? <Loader2 className="animate-spin" /> : null}
        {mergeInProgress ? "Abort Merge" : "Sync with Base Branch"}
      </Button>

      <AlertDialog onOpenChange={setConfirmingAbort} open={confirmingAbort}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Abort merge?</AlertDialogTitle>
            <AlertDialogDescription>
              This will discard all conflict-resolution changes and restore this worktree to its
              state before merging {pr.baseRef}. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void abortMerge()}>Abort merge</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CheckStateIcon({ state }: { state: CheckStatusItem["state"] }) {
  if (state === "success") return <CheckCircle2 className="size-3.5 text-success" />;
  if (state === "failure") return <XCircle className="size-3.5 text-destructive" />;
  return <CircleDot className="size-3.5 text-warning" />;
}

/** Renders aggregate check counts and an expandable per-check status list. */
export function ChecksSummary({ checks }: { checks: ChecksStatus | null }) {
  if (!checks || checks.state === "none") {
    return <p className="text-xs text-muted-foreground">No checks reported.</p>;
  }
  const summary =
    checks.state === "success"
      ? `All ${checks.total} checks passed`
      : checks.state === "failure"
        ? `${checks.failed} of ${checks.total} checks failed`
        : `${checks.passed}/${checks.total} checks complete`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`${summary}. Show check details`}
          className="h-auto w-full justify-start gap-2 px-1 py-1 text-xs"
          variant="ghost"
        >
          <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
          <span className="inline-flex items-center gap-0.5 text-success" title="Succeeded">
            <CheckCircle2 className="size-3.5" /> {checks.passed}
          </span>
          <span className="inline-flex items-center gap-0.5 text-destructive" title="Failed">
            <XCircle className="size-3.5" /> {checks.failed}
          </span>
          <span className="inline-flex items-center gap-0.5 text-warning" title="In progress">
            <CircleDot className="size-3.5" /> {checks.pending}
          </span>
          <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>GitHub checks</DropdownMenuLabel>
        {checks.items.map((item) => (
          <DropdownMenuItem
            className="justify-between"
            disabled={!item.url}
            key={`${item.name}-${item.url ?? item.state}`}
            onSelect={() => {
              if (item.url) void browserOpenExternal(item.url);
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <CheckStateIcon state={item.state} />
              <span className="truncate">{item.name}</span>
            </span>
            <span className="text-[10px] capitalize text-muted-foreground">{item.state}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  targets,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: BranchCleanupTarget[];
  onChanged: () => void;
}) {
  const workspace = useWorkspace();
  const [deleteRemote, setDeleteRemote] = useState(true);
  const [working, setWorking] = useState(false);

  const cleanup = useCallback(async () => {
    setWorking(true);
    try {
      if (deleteRemote) {
        for (const target of targets) {
          // eslint-disable-next-line no-await-in-loop -- parent worktrees must survive child cleanup.
          await githubDeleteRemoteBranch(target.worktreeId);
        }
      }
      for (const target of targets) {
        // eslint-disable-next-line no-await-in-loop -- delete stack children before their parents.
        await workspace.deleteWorktree(target.worktreeId, { deleteBranch: true, force: true });
      }
      toast.success(
        `Cleaned up ${targets.length} merged branch${targets.length === 1 ? "" : "es"}`,
      );
      onOpenChange(false);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  }, [deleteRemote, targets, workspace, onOpenChange, onChanged]);

  const branchNames = targets.map((target) => target.headRef).join(", ");

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Clean up {targets.length === 1 ? "branch" : "stack branches"}</DialogTitle>
          <DialogDescription>
            {targets.length === 1
              ? `#${targets[0]?.prNumber ?? ""} is merged. Delete its worktree and local branch`
              : `${targets.length} pull requests are merged. Delete their worktrees and local branches`}
            {deleteRemote ? ", and the remote branch" : ""}?
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={deleteRemote}
            onCheckedChange={(value) => setDeleteRemote(value === true)}
          />
          Also delete remote {targets.length === 1 ? "branch" : "branches"} ({branchNames})
        </label>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="outline">
            Keep
          </Button>
          <Button disabled={working} onClick={() => void cleanup()} size="sm" variant="destructive">
            {working ? <Loader2 className="animate-spin" /> : null}
            Delete {targets.length === 1 ? "branch" : "branches"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
