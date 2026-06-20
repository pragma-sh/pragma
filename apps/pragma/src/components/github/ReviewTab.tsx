import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FileDiff, GitHubRepoRef, Tab } from "@pragma/constants";
import { Check, CheckCircle2, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { GitHubMarkdown } from "@/components/github/GitHubMarkdown";
import { ActorAvatar } from "@/components/github/ViewPullRequestView";
import { type DiffComment, MergeDiff } from "@/components/editor/MergeDiff";
import { Button } from "@/components/ui/button";
import {
  type PullFile,
  type PullRequestSummary,
  type PullReview,
  type ReviewThread,
  getPullRequest,
  listPullFiles,
  listPullReviews,
  listReviewThreads,
  resolveReviewThread,
  unresolveReviewThread,
} from "@/lib/github";
import { githubPrFileDiff, githubRepoRef } from "@/lib/tauri";
import { useReviewDone, setReviewDone } from "@/state/review-done-store";

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface ReviewData {
  repo: GitHubRepoRef;
  pr: PullRequestSummary;
  files: PullFile[];
  reviews: PullReview[];
  threadsByPath: Map<string, ReviewThread[]>;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: ReviewData };

/**
 * The PR review tab (one `pr-review` tab per PR). A scrollable list of changed
 * files; each file has a sticky header with a **Done reviewing** toggle (ephemeral
 * `review-done-store`, collapses the diff when checked), a side-by-side
 * `base...HEAD` diff from `github_pr_file_diff`, and the file's inline review
 * threads, each resolvable via `resolveReviewThread` (resolved threads dim).
 */
export function ReviewTab({ tab }: { tab: Tab }) {
  const { worktreeId, prNumber } = tab;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const active = useRef(true);

  const load = useCallback(async () => {
    if (prNumber === null || prNumber === undefined) {
      setState({ kind: "error", message: "This review tab is missing its pull request number." });
      return;
    }
    setState({ kind: "loading" });
    try {
      const repo = await githubRepoRef(worktreeId);
      const [pr, files, reviews, threads] = await Promise.all([
        getPullRequest(repo, prNumber),
        listPullFiles(repo, prNumber),
        listPullReviews(repo, prNumber),
        listReviewThreads(repo, prNumber),
      ]);
      const threadsByPath = new Map<string, ReviewThread[]>();
      for (const thread of threads) {
        const bucket = threadsByPath.get(thread.path);
        if (bucket) {
          bucket.push(thread);
        } else {
          threadsByPath.set(thread.path, [thread]);
        }
      }
      if (active.current) {
        setState({ kind: "ready", data: { repo, pr, files, reviews, threadsByPath } });
      }
    } catch (cause) {
      if (active.current) {
        setState({ kind: "error", message: messageFor(cause) });
      }
    }
  }, [worktreeId, prNumber]);

  // Optimistically flips one thread's resolved state in place — no refetch, so the
  // diff panes and decorations don't flash. The mutating call reverts via this same
  // setter on failure (see `ReviewThreadCard`). Stable (functional update) so each
  // file's memoized inline-comment content only changes when its threads actually do.
  const setThreadResolved = useCallback((threadId: string, isResolved: boolean) => {
    setState((prev) => {
      if (prev.kind !== "ready") {
        return prev;
      }
      // Clone only the bucket that holds this thread; every other path keeps its
      // array reference so its memoized inline comments don't recompute.
      const threadsByPath = new Map(prev.data.threadsByPath);
      for (const [path, threads] of threadsByPath) {
        const index = threads.findIndex((thread) => thread.id === threadId);
        const current = index === -1 ? undefined : threads[index];
        if (!current) {
          continue;
        }
        const updated = threads.slice();
        updated[index] = { ...current, isResolved };
        threadsByPath.set(path, updated);
        break;
      }
      return { kind: "ready", data: { ...prev.data, threadsByPath } };
    });
  }, []);

  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
    };
  }, [load]);

  if (state.kind === "loading") {
    return <Centered>Loading review…</Centered>;
  }
  if (state.kind === "error") {
    return <Centered tone="error">{state.message}</Centered>;
  }

  const { data } = state;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-[#0b0d10]">
      <div className="border-b border-white/10 px-4 py-2">
        <p className="text-sm font-semibold text-slate-100">
          {data.pr.title} <span className="text-slate-500">#{data.pr.number}</span>
        </p>
        <p className="text-xs text-slate-500">
          {data.files.length} file{data.files.length === 1 ? "" : "s"} · {data.pr.baseRef} ←{" "}
          {data.pr.headRef}
        </p>
      </div>
      {data.reviews.length > 0 ? (
        <div className="flex flex-col gap-2 border-b border-white/10 p-3">
          {data.reviews.map((review) => (
            <ReviewSummaryCard key={review.id} review={review} />
          ))}
        </div>
      ) : null}
      {data.files.map((file) => (
        <FileReview
          base={data.pr.baseRef}
          file={file}
          key={file.path}
          onThreadResolvedChange={setThreadResolved}
          prNumber={data.pr.number}
          threads={data.threadsByPath.get(file.path) ?? []}
          worktreeId={worktreeId}
        />
      ))}
    </div>
  );
}

/** Human label + badge styling for each review verdict. */
const REVIEW_STATE_META: Record<PullReview["state"], { label: string; className: string }> = {
  APPROVED: { label: "approved", className: "bg-green-700/40 text-green-300" },
  CHANGES_REQUESTED: { label: "requested changes", className: "bg-red-700/40 text-red-300" },
  COMMENTED: { label: "commented", className: "bg-slate-600/40 text-slate-300" },
  DISMISSED: { label: "dismissed", className: "bg-slate-600/40 text-slate-400" },
  PENDING: { label: "pending", className: "bg-amber-600/40 text-amber-200" },
};

/**
 * A submitted review — the parent that groups a reviewer's inline comments —
 * showing the reviewer, their verdict, and the overall summary body.
 */
function ReviewSummaryCard({ review }: { review: PullReview }) {
  const meta = REVIEW_STATE_META[review.state] ?? REVIEW_STATE_META.COMMENTED;
  return (
    <div className="rounded-md border border-white/10 bg-black/20 p-2">
      <div className="flex items-center gap-2">
        <ActorAvatar actor={review.user} />
        <span className="text-xs text-slate-300">{review.user?.login ?? "ghost"}</span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${meta.className}`}>
          {meta.label}
        </span>
      </div>
      {review.body.trim().length > 0 ? (
        <div className="mt-2">
          <GitHubMarkdown>{review.body}</GitHubMarkdown>
        </div>
      ) : null}
    </div>
  );
}

/** One file's review block: header + done toggle, collapsible diff, inline threads. */
function FileReview({
  base,
  file,
  prNumber,
  threads,
  worktreeId,
  onThreadResolvedChange,
}: {
  base: string;
  file: PullFile;
  prNumber: number;
  threads: ReviewThread[];
  worktreeId: string;
  onThreadResolvedChange: (threadId: string, isResolved: boolean) => void;
}) {
  const done = useReviewDone(prNumber, file.path);
  const unresolved = threads.filter((thread) => !thread.isResolved).length;

  // Threads with a line anchor render inline next to the code; line-less threads
  // (file-level comments) fall back to a list beneath the diff.
  const inlineComments = useMemo<DiffComment[]>(
    () =>
      threads
        .filter((thread): thread is ReviewThread & { line: number } => thread.line !== null)
        .map((thread) => ({
          key: thread.id,
          line: thread.line,
          content: (
            <div className="border-y border-white/10 bg-black/30 px-3 py-2">
              <ReviewThreadCard onResolvedChange={onThreadResolvedChange} thread={thread} />
            </div>
          ),
        })),
    [threads, onThreadResolvedChange],
  );
  const fileComments = threads.filter((thread) => thread.line === null);

  return (
    <section className="border-b border-white/10">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/5 bg-[#11151b] px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-slate-200" title={file.path}>
          {file.path}
        </span>
        {unresolved > 0 ? (
          <span className="shrink-0 rounded bg-amber-500/20 px-1 text-[10px] text-amber-300">
            {unresolved} unresolved
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[10px] text-emerald-400">+{file.additions}</span>
        <span className="shrink-0 font-mono text-[10px] text-red-400">-{file.deletions}</span>
        <Button
          className="shrink-0"
          onClick={() => setReviewDone(prNumber, file.path, !done)}
          size="xs"
          variant={done ? "secondary" : "outline"}
        >
          <Check />
          {done ? "Reviewed" : "Done reviewing"}
        </Button>
      </header>
      {done ? null : (
        <>
          <FileDiffPane base={base} comments={inlineComments} file={file} worktreeId={worktreeId} />
          {fileComments.length > 0 ? (
            <div className="flex flex-col gap-2 border-t border-white/5 p-2">
              {fileComments.map((thread) => (
                <ReviewThreadCard
                  key={thread.id}
                  onResolvedChange={onThreadResolvedChange}
                  thread={thread}
                />
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Lazily loads + renders a single file's local `base...HEAD` diff. */
function FileDiffPane({
  base,
  comments,
  file,
  worktreeId,
}: {
  base: string;
  comments: DiffComment[];
  file: PullFile;
  worktreeId: string;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await githubPrFileDiff(worktreeId, base, file.path, file.oldPath);
        if (!cancelled) {
          setDiff(result);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(messageFor(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [worktreeId, base, file.path, file.oldPath]);

  if (error) {
    return <p className="px-3 py-2 text-xs text-destructive">{error}</p>;
  }
  if (!diff) {
    return <p className="px-3 py-2 text-xs text-slate-500">Loading diff…</p>;
  }
  if (diff.binary) {
    return <p className="px-3 py-2 text-xs text-slate-500">Binary file — no diff.</p>;
  }
  return (
    <div className="h-80 min-h-0">
      <MergeDiff
        comments={comments}
        fileName={file.path}
        newText={diff.newText}
        oldText={diff.oldText}
      />
    </div>
  );
}

/**
 * A compact inline review thread with a Resolve / Unresolve toggle; resolved
 * threads dim. The toggle updates **optimistically** via `onResolvedChange` —
 * the parent flips the thread's state in place without a refetch — and only
 * surfaces a toast when the GitHub mutation actually fails, reverting the
 * optimistic flip so the UI matches the server again.
 */
function ReviewThreadCard({
  thread,
  onResolvedChange,
}: {
  thread: ReviewThread;
  onResolvedChange: (threadId: string, isResolved: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(thread.isResolved);

  const toggleResolved = useCallback(async () => {
    const next = !thread.isResolved;
    setBusy(true);
    onResolvedChange(thread.id, next); // optimistic
    try {
      await (next ? resolveReviewThread(thread.id) : unresolveReviewThread(thread.id));
    } catch (cause) {
      onResolvedChange(thread.id, !next); // revert on failure
      toast.error(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }, [thread.id, thread.isResolved, onResolvedChange]);

  return (
    <div
      className={`rounded-md border border-white/10 bg-black/20 p-2 ${thread.isResolved ? "opacity-60" : ""}`}
    >
      <Button
        className="h-auto w-full justify-start gap-1 px-0 py-0 text-[11px] font-normal text-slate-400 hover:bg-transparent hover:text-slate-200"
        onClick={() => setCollapsed((value) => !value)}
        size="xs"
        variant="ghost"
      >
        {collapsed ? <ChevronRight /> : <ChevronDown />}
        {thread.line ? `Line ${thread.line}` : "File comment"}
        {thread.isResolved ? (
          <span className="ml-1 inline-flex items-center gap-0.5 text-green-400">
            <CheckCircle2 className="size-3" /> resolved
          </span>
        ) : null}
      </Button>
      {collapsed ? null : (
        <div className="mt-2 flex flex-col gap-2">
          {thread.comments.map((comment, index) => (
            // `comment.id` falls back to 0 when GitHub omits `databaseId`, so it can
            // collide within a thread; the position disambiguates. Comments in a thread
            // are append-only and never reorder, so the index is stable.
            // oxlint-disable-next-line no-array-index-key -- composite key needs the index for uniqueness when databaseId is missing
            <div className="flex gap-2" key={`${thread.id}:${comment.id}:${index}`}>
              <ActorAvatar actor={comment.user} />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-slate-400">{comment.user?.login ?? "ghost"}</p>
                <GitHubMarkdown>{comment.body}</GitHubMarkdown>
              </div>
            </div>
          ))}
          <Button
            className="self-start"
            disabled={busy}
            onClick={() => void toggleResolved()}
            size="sm"
            variant="outline"
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        </div>
      )}
    </div>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      className={`flex h-full items-center justify-center bg-[#0b0d10] p-6 text-center text-sm ${
        tone === "error" ? "text-destructive" : "text-slate-400"
      }`}
    >
      {children}
    </div>
  );
}
