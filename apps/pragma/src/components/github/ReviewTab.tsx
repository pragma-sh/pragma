import {
  type Dispatch,
  type SetStateAction,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { errorMessage } from "@/lib/errors";

import type { GitHubRepoRef, Tab } from "@pragma-sh/constants";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ListChecks,
  Loader2,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import type { DiffComment } from "@/components/editor/MergeDiff";
import { FixCommentDialog } from "@/components/github/FixCommentDialog";
import { FixItListDialog } from "@/components/github/FixItListDialog";
import { GitHubMarkdown } from "@/components/github/GitHubMarkdown";
import { PullRequestStackCard } from "@/components/github/PullRequestStackCard";
import { ActorAvatar } from "@/components/github/ViewPullRequestView";
import {
  type ReviewData,
  buildCommentKeys,
  flattenThreads,
  groupThreadsByPath,
  REVIEW_REFRESH_INTERVAL_MS,
  reuseUnchangedReviewData,
  reviewDataSignature,
} from "@/components/github/review-data";
import { DEFAULT_DIFF_PANE_HEIGHT_PX, FileDiffPane } from "@/components/github/ReviewFileDiff";
import {
  type ReviewCommentTarget,
  nextReachableIndex,
  settleCommentIntoView,
} from "@/components/github/review-scroll";
import { startRefreshLoop } from "@/components/right-sidebar/refresh-loop";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  type PullFile,
  type PullReview,
  type ReviewThread,
  getPullRequest,
  listPullFiles,
  listPullReviews,
  listReviewThreads,
  resolveReviewThread,
  unresolveReviewThread,
} from "@/lib/github";
import { githubCacheKeys, subscribeGitHubCache, writeGitHubCache } from "@/lib/github-cache";
import { reviewThreadToFixItComment } from "@/lib/fix-it-prompt";
import { githubRepoRef } from "@/lib/tauri";
import {
  addFixItComment,
  type FixItComment,
  removeFixItComment,
  useFixItComments,
  useIsFixItComment,
} from "@/state/fix-it-store";
import { useReviewDone, setReviewDone } from "@/state/review-done-store";
import { clearReviewFocus, useReviewFocus } from "@/state/review-focus-store";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: ReviewData };

async function fetchReviewData(
  worktreeId: string,
  repoCache: { current: GitHubRepoRef | null },
  prNumber: number,
  force: boolean,
  reviews: PullReview[],
): Promise<{ data: ReviewData; reviewsPromise: Promise<PullReview[] | null> }> {
  // A worktree's GitHub remote doesn't change under an open tab, and resolving
  // it shells out to git — so it's resolved once, not on every poll/cache tick.
  repoCache.current ??= await githubRepoRef(worktreeId);
  const repo = repoCache.current;
  const reviewsPromise = listPullReviews(repo, prNumber, { force }).catch(() => null);
  const [pr, files, threads] = await Promise.all([
    getPullRequest(repo, prNumber, { force }),
    listPullFiles(repo, prNumber, { force }),
    listReviewThreads(repo, prNumber, { force }),
  ]);
  return {
    data: { repo, pr, files, reviews, threadsByPath: groupThreadsByPath(threads) },
    reviewsPromise,
  };
}

function publishReviewData(
  data: ReviewData,
  signature: { current: string | null },
  setState: Dispatch<SetStateAction<LoadState>>,
): boolean {
  const nextSignature = reviewDataSignature(data);
  if (signature.current === nextSignature) return false;
  signature.current = nextSignature;
  setState((prev) => ({
    kind: "ready",
    data: prev.kind === "ready" ? reuseUnchangedReviewData(prev.data, data) : data,
  }));
  return true;
}

function publishReviewLoadError(
  cause: unknown,
  active: boolean,
  hasReady: boolean,
  setState: (state: LoadState) => void,
): void {
  if (active && !hasReady) {
    setState({ kind: "error", message: errorMessage(cause) });
  }
}

/** Load the PR + files + reviews + threads, and own the optimistic thread-resolve flip. */
function useReviewData(worktreeId: string, prNumber: number | null) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const active = useRef(true);
  // First paint goes through loading; later background refetches keep ready data
  // on screen so a cache hit doesn't flash the spinner again.
  const hasReady = useRef(false);
  const signature = useRef<string | null>(null);
  const reviewsRef = useRef<PullReview[]>([]);
  const repoRef = useRef<GitHubRepoRef | null>(null);

  const load = useCallback(
    async (force = false) => {
      if (prNumber === null || prNumber === undefined) {
        setState({ kind: "error", message: "This review tab is missing its pull request number." });
        return;
      }
      if (!hasReady.current) {
        setState({ kind: "loading" });
      }
      try {
        // Review summaries are optional chrome. Start them with critical requests,
        // but do not make inline comments wait for their REST pagination.
        const { data, reviewsPromise } = await fetchReviewData(
          worktreeId,
          repoRef,
          prNumber,
          force,
          reviewsRef.current,
        );
        if (!active.current) return;
        hasReady.current = publishReviewData(data, signature, setState) || hasReady.current;

        const reviews = await reviewsPromise;
        if (!active.current || reviews === null) return;
        reviewsRef.current = reviews;
        const dataWithReviews = { ...data, reviews };
        publishReviewData(dataWithReviews, signature, setState);
      } catch (cause) {
        publishReviewLoadError(cause, active.current, hasReady.current, setState);
      }
    },
    [worktreeId, prNumber],
  );

  // Optimistically flips one thread's resolved state in place — no refetch, so the
  // diff panes and decorations don't flash. Also seeds the threads cache so a
  // follow-up SWR poll cannot clobber the flip with a pre-resolve snapshot.
  const setThreadResolved = useCallback((threadId: string, isResolved: boolean) => {
    setState((prev) => {
      if (prev.kind !== "ready") {
        return prev;
      }
      // Clone only the bucket that holds this thread; every other path keeps its
      // array reference so its memoized inline comments don't recompute.
      const threadsByPath = new Map(prev.data.threadsByPath);
      let found = false;
      for (const [path, threads] of threadsByPath) {
        const index = threads.findIndex((thread) => thread.id === threadId);
        const current = index === -1 ? undefined : threads[index];
        if (!current) {
          continue;
        }
        const updated = threads.slice();
        updated[index] = { ...current, isResolved };
        threadsByPath.set(path, updated);
        found = true;
        break;
      }
      if (!found) {
        return prev;
      }
      const data = { ...prev.data, threadsByPath };
      writeGitHubCache(
        githubCacheKeys(prev.data.repo).threads(prev.data.pr.number),
        flattenThreads(threadsByPath),
      );
      signature.current = reviewDataSignature(data);
      return { kind: "ready", data };
    });
  }, []);

  useEffect(() => {
    active.current = true;
    hasReady.current = false;
    signature.current = null;
    reviewsRef.current = [];
    repoRef.current = null;
    // Poll with force=false so cache serves stale-while-revalidate; each tick
    // + window focus still revalidates in the background while the tab is open.
    const stopRefresh = startRefreshLoop(() => load(false), REVIEW_REFRESH_INTERVAL_MS);
    return () => {
      active.current = false;
      stopRefresh();
    };
  }, [load]);

  // When a background revalidate finishes writing the store, re-read so the UI
  // picks up new comments/files without waiting for the next interval tick.
  const repoIdentity =
    state.kind === "ready" ? `${state.data.repo.owner}/${state.data.repo.repo}` : null;
  useEffect(() => {
    if (prNumber === null || prNumber === undefined || !repoIdentity) {
      return;
    }
    const slash = repoIdentity.indexOf("/");
    const owner = repoIdentity.slice(0, slash);
    const repo = repoIdentity.slice(slash + 1);
    const keys = githubCacheKeys({ owner, repo });
    const apply = () => {
      void load(false);
    };
    const stops = [
      subscribeGitHubCache(keys.pr(prNumber), apply),
      subscribeGitHubCache(keys.files(prNumber), apply),
      subscribeGitHubCache(keys.reviews(prNumber), apply),
      subscribeGitHubCache(keys.threads(prNumber), apply),
    ];
    return () => {
      for (const stop of stops) {
        stop();
      }
    };
  }, [load, prNumber, repoIdentity]);

  return { state, setThreadResolved };
}

/** DOM-node registries so focus requests and toolbar arrows can reach file sections and comments. */
function useReviewRegistration() {
  const sectionEls = useRef(new Map<string, HTMLElement>());
  const commentTargets = useRef(new Map<string, ReviewCommentTarget>());
  const registerSection = useCallback((path: string, el: HTMLElement | null) => {
    if (el) {
      sectionEls.current.set(path, el);
    } else {
      sectionEls.current.delete(path);
    }
  }, []);
  const registerCommentTarget = useCallback((key: string, target: ReviewCommentTarget | null) => {
    if (target) {
      commentTargets.current.set(key, target);
    } else {
      commentTargets.current.delete(key);
    }
  }, []);
  return { sectionEls, commentTargets, registerSection, registerCommentTarget };
}

/** Scroll a focus-requested file into view once its section is mounted, then clear the request. */
function useReviewFocusScroll(
  state: LoadState,
  prNumber: number | null,
  focusPath: string | null,
  sectionEls: React.RefObject<Map<string, HTMLElement>>,
): void {
  useEffect(() => {
    if (state.kind !== "ready" || prNumber == null || focusPath === null) {
      return;
    }
    const el = sectionEls.current.get(focusPath);
    if (!el) {
      return;
    }
    el.scrollIntoView({ block: "start" });
    clearReviewFocus(prNumber);
  }, [focusPath, state.kind, prNumber, sectionEls]);
}

/** Whether the key is Cmd/Ctrl (no alt/shift) + an arrow up/down. */
function isReviewNavKey(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey)) {
    return false;
  }
  if (event.altKey || event.shiftKey) {
    return false;
  }
  return event.key === "ArrowDown" || event.key === "ArrowUp";
}

/** Whether the event target is an input/textarea/contenteditable (don't hijack typing). */
function isTypingTarget(target: HTMLElement | null): boolean {
  return !!target?.closest("input, textarea, [contenteditable='true']");
}

/** Decide whether a keyboard event is a scoped Cmd/Ctrl+↑/↓ review navigation keystroke. */
function shouldHandleReviewArrowKey(
  event: KeyboardEvent,
  scrollRef: React.RefObject<HTMLDivElement | null>,
): boolean {
  if (!isReviewNavKey(event)) {
    return false;
  }
  if (!scrollRef.current || scrollRef.current.offsetParent === null) {
    return false;
  }
  return !isTypingTarget(event.target as HTMLElement | null);
}

/**
 * The PR review tab (one `pr-review` tab per PR). A scrollable list of changed
 * files; each file has a sticky header with a **Done reviewing** toggle (ephemeral
 * `review-done-store`, collapses the diff when checked), a side-by-side
 * `base...HEAD` diff from `github_pr_file_diff`, and the file's inline review
 * threads, each resolvable via `resolveReviewThread` (resolved threads dim).
 *
 * Data + diffs use the same SWR + 10s refresh pattern as the Pull Request sidebar:
 * first paint can hit the GitHub/local-diff cache immediately; interval and focus
 * polls revalidate in the background without flashing a loading spinner.
 */
export function ReviewTab({ tab }: { tab: Tab }) {
  const { worktreeId, prNumber } = tab;
  const { state, setThreadResolved } = useReviewData(worktreeId, prNumber);
  const { sectionEls, commentTargets, registerSection, registerCommentTarget } =
    useReviewRegistration();
  // The review scroll container, so the sticky toolbar can scroll a comment into
  // view (each comment marks its DOM node with `data-review-comment`).
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusPath = useReviewFocus(prNumber);
  // The comment a single-comment "Fix" dialog is open for (null when closed), and
  // whether the "Address fix it list" dialog is open.
  const [fixTarget, setFixTarget] = useState<FixItComment | null>(null);
  const [listOpen, setListOpen] = useState(false);
  useReviewFocusScroll(state, prNumber, focusPath, sectionEls);
  // Memoized so the toolbar's keyboard listener isn't re-bound on every render.
  const commentKeys = useMemo(
    () =>
      state.kind === "ready" ? buildCommentKeys(state.data.files, state.data.threadsByPath) : [],
    [state],
  );

  if (state.kind === "loading") {
    return <Centered>Loading review…</Centered>;
  }
  if (state.kind === "error") {
    return <Centered tone="error">{state.message}</Centered>;
  }

  const { data } = state;
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-auto bg-canvas"
      data-review-scroll
      ref={scrollRef}
    >
      <div className="flex items-start gap-2 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {data.pr.title} <span className="text-muted-foreground">#{data.pr.number}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {data.files.length} file{data.files.length === 1 ? "" : "s"} · {data.pr.baseRef} ←{" "}
            {data.pr.headRef}
          </p>
        </div>
      </div>
      <PullRequestStackCard compact pr={data.pr} repo={data.repo} worktreeId={worktreeId} />
      <ReviewToolbar
        commentKeys={commentKeys}
        commentTargets={commentTargets}
        onAddressFixIt={() => setListOpen(true)}
        prNumber={data.pr.number}
        scrollRef={scrollRef}
      />
      {data.reviews.length > 0 ? (
        <div className="flex flex-col gap-2 border-b border-border p-3">
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
          onFix={setFixTarget}
          onThreadResolvedChange={setThreadResolved}
          prNumber={data.pr.number}
          registerCommentTarget={registerCommentTarget}
          registerSection={registerSection}
          threads={data.threadsByPath.get(file.path) ?? []}
          worktreeId={worktreeId}
        />
      ))}
      {fixTarget !== null ? (
        <FixCommentDialog
          comment={fixTarget}
          onOpenChange={(open) => {
            if (!open) {
              setFixTarget(null);
            }
          }}
          open={true}
          worktreeId={worktreeId}
        />
      ) : null}
      {listOpen ? (
        <FixItListDialog
          onOpenChange={setListOpen}
          open={true}
          prNumber={data.pr.number}
          worktreeId={worktreeId}
        />
      ) : null}
    </div>
  );
}

/**
 * Sticky toolbar pinned above the file list (below the workspace tab bar): step
 * between review comments with the arrows and open the fix-it list to fix them
 * all. It lives inside the review scroll container so it stays put while the
 * diffs scroll beneath it. Each step lands the comment in the middle of its diff
 * pane and the pane in the middle of the screen (see `settleCommentIntoView`);
 * comments in collapsed/reviewed files are skipped.
 */
function ReviewToolbar({
  commentKeys,
  commentTargets,
  prNumber,
  scrollRef,
  onAddressFixIt,
}: {
  commentKeys: string[];
  commentTargets: React.RefObject<Map<string, ReviewCommentTarget>>;
  prNumber: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onAddressFixIt: () => void;
}) {
  // Index into `commentKeys` of the comment we last scrolled to; -1 before any
  // navigation so the first "next" lands on the first comment. State (not a ref)
  // so the arrows re-render their disabled state as the cursor moves.
  const [cursor, setCursor] = useState(-1);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // Stops the in-flight settle, so a quick second press never fights the first.
  const stopSettling = useRef<(() => void) | null>(null);
  useEffect(() => () => stopSettling.current?.(), []);

  // Keep the cursor in range if the comment set shrinks (e.g. after a refetch).
  useEffect(() => {
    setCursor((current) => Math.min(current, commentKeys.length - 1));
  }, [commentKeys.length]);

  const go = useCallback(
    (direction: "next" | "prev") => {
      const scroller = scrollRef.current;
      if (!scroller) {
        return;
      }
      const nodeFor = (key: string) =>
        scroller.querySelector<HTMLElement>(`[data-review-comment="${CSS.escape(key)}"]`);
      // Reachable: already mounted, or its diff registered a target. Comments in
      // a collapsed (reviewed) file have neither, so they're skipped.
      const index = nextReachableIndex(
        commentKeys,
        cursor,
        direction === "next" ? 1 : -1,
        (key) => commentTargets.current.has(key) || nodeFor(key) !== null,
      );
      const key = commentKeys[index];
      if (key === undefined) {
        return;
      }
      setCursor(index);
      stopSettling.current?.();
      stopSettling.current = settleCommentIntoView({
        outer: scroller,
        topInset: toolbarRef.current?.offsetHeight ?? 0,
        findNode: () => nodeFor(key),
        target: commentTargets.current.get(key) ?? null,
      });
    },
    [commentKeys, commentTargets, cursor, scrollRef],
  );

  // Cmd/Ctrl + ↑/↓ step between comments without leaving the keyboard. Scoped to
  // this tab's visible scroll container (`offsetParent` is null when an ancestor is
  // `display: none`, e.g. a background pane) so only the on-screen review responds.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleReviewArrowKey(event, scrollRef)) {
        return;
      }
      event.preventDefault();
      go(event.key === "ArrowDown" ? "next" : "prev");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go, scrollRef]);

  const count = commentKeys.length;
  // Disable each arrow at the ends of the list — nothing above the first comment,
  // nothing below the last.
  const hasPrev = cursor > 0;
  const hasNext = cursor < count - 1;
  return (
    <div
      className="sticky top-0 z-20 flex h-9 shrink-0 items-center gap-2 border-b border-border bg-elevated px-3"
      ref={toolbarRef}
    >
      <div className="flex items-center gap-0.5">
        <IconButton
          disabled={!hasPrev}
          label="Previous comment"
          onClick={() => go("prev")}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronUp />
        </IconButton>
        <IconButton
          disabled={!hasNext}
          label="Next comment"
          onClick={() => go("next")}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronDown />
        </IconButton>
      </div>
      <span className="text-[11px] text-muted-foreground">
        {count} comment{count === 1 ? "" : "s"}
      </span>
      <div className="flex-1" />
      <AddressFixItButton onClick={onAddressFixIt} prNumber={prNumber} />
    </div>
  );
}

/** Top-of-tab button opening the fix-it list dialog, badged with the flagged count. */
function AddressFixItButton({ prNumber, onClick }: { prNumber: number; onClick: () => void }) {
  const count = useFixItComments(prNumber).length;
  return (
    <Button
      className="shrink-0"
      disabled={count === 0}
      onClick={onClick}
      size="xs"
      variant="outline"
    >
      <ListChecks />
      Address fix it list
      {count > 0 ? (
        <span className="ml-1 rounded bg-warning/20 px-1 text-[10px] text-warning">{count}</span>
      ) : null}
    </Button>
  );
}

/** Human label + badge styling for each review verdict. */
const REVIEW_STATE_META: Record<PullReview["state"], { label: string; className: string }> = {
  APPROVED: { label: "approved", className: "bg-success/20 text-success" },
  CHANGES_REQUESTED: {
    label: "requested changes",
    className: "bg-destructive/20 text-destructive",
  },
  COMMENTED: { label: "commented", className: "bg-muted text-muted-foreground" },
  DISMISSED: { label: "dismissed", className: "bg-muted text-muted-foreground" },
  PENDING: { label: "pending", className: "bg-warning/20 text-warning" },
};

/**
 * A submitted review — the parent that groups a reviewer's inline comments —
 * showing the reviewer, their verdict, and the overall summary body.
 */
function ReviewSummaryCard({ review }: { review: PullReview }) {
  const meta = REVIEW_STATE_META[review.state] ?? REVIEW_STATE_META.COMMENTED;
  return (
    <div className="rounded-md border border-border bg-canvas p-2">
      <div className="flex items-center gap-2">
        <ActorAvatar actor={review.user} />
        <span className="text-xs text-muted-foreground">{review.user?.login ?? "ghost"}</span>
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

/**
 * One file's review block: header + done toggle, collapsible diff, inline
 * threads. Memoized — every prop is stable across refreshes unless this file or
 * its threads changed (see `reuseUnchangedReviewData`), so a large PR re-renders
 * only the sections that actually moved.
 */
const FileReview = memo(function FileReview({
  base,
  file,
  prNumber,
  threads,
  worktreeId,
  onFix,
  onThreadResolvedChange,
  registerCommentTarget,
  registerSection,
}: {
  base: string;
  file: PullFile;
  prNumber: number;
  threads: ReviewThread[];
  worktreeId: string;
  onFix: (comment: FixItComment) => void;
  onThreadResolvedChange: (threadId: string, isResolved: boolean) => void;
  registerCommentTarget: (key: string, target: ReviewCommentTarget | null) => void;
  registerSection: (path: string, el: HTMLElement | null) => void;
}) {
  const done = useReviewDone(prNumber, file.path);
  const headerRef = useRef<HTMLElement>(null);
  // Lives here, not in the pane, so a dragged height survives "Done reviewing".
  const [paneHeight, setPaneHeight] = useState(DEFAULT_DIFF_PANE_HEIGHT_PX);
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
            <div
              className="border-y border-border bg-canvas px-3 py-2"
              data-review-comment={thread.id}
            >
              <ReviewThreadCard
                onFix={onFix}
                onResolvedChange={onThreadResolvedChange}
                prNumber={prNumber}
                thread={thread}
              />
            </div>
          ),
        })),
    [threads, prNumber, onFix, onThreadResolvedChange],
  );
  const fileComments = threads.filter((thread) => thread.line === null);

  return (
    <section className="border-b border-border" ref={(el) => registerSection(file.path, el)}>
      <header
        className="sticky top-9 z-10 flex items-center gap-2 border-b border-border bg-elevated px-3 py-1.5"
        ref={headerRef}
      >
        <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={file.path}>
          {file.path}
        </span>
        {unresolved > 0 ? (
          <span className="shrink-0 rounded bg-warning/20 px-1 text-[10px] text-warning">
            {unresolved} unresolved
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[10px] text-success">+{file.additions}</span>
        <span className="shrink-0 font-mono text-[10px] text-destructive">-{file.deletions}</span>
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
          <FileDiffPane
            base={base}
            comments={inlineComments}
            file={file}
            headerRef={headerRef}
            height={paneHeight}
            onHeightChange={setPaneHeight}
            registerCommentTarget={registerCommentTarget}
            worktreeId={worktreeId}
          />
          {fileComments.length > 0 ? (
            <div className="flex flex-col gap-2 border-t border-border p-2">
              {fileComments.map((thread) => (
                <div data-review-comment={thread.id} key={thread.id}>
                  <ReviewThreadCard
                    onFix={onFix}
                    onResolvedChange={onThreadResolvedChange}
                    prNumber={prNumber}
                    thread={thread}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
});

/** Collapsible header showing the thread's line (or "File comment") and resolved state. */
function ReviewThreadHeader({
  thread,
  collapsed,
  onToggle,
}: {
  thread: ReviewThread;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      className="h-auto w-full justify-start gap-1 px-0 py-0 text-[11px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
      onClick={onToggle}
      size="xs"
      variant="ghost"
    >
      {collapsed ? <ChevronRight /> : <ChevronDown />}
      {thread.line ? `Line ${thread.line}` : "File comment"}
      {thread.isResolved ? (
        <span className="ml-1 inline-flex items-center gap-0.5 text-success">
          <CheckCircle2 className="size-3" /> resolved
        </span>
      ) : null}
    </Button>
  );
}

/** The thread's comments (append-only; index disambiguates when databaseId is missing). */
function ReviewThreadComments({ thread }: { thread: ReviewThread }) {
  return (
    <>
      {thread.comments.map((comment, index) => (
        // `comment.id` falls back to 0 when GitHub omits `databaseId`, so it can
        // collide within a thread; the position disambiguates. Comments in a thread
        // are append-only and never reorder, so the index is stable.
        // oxlint-disable-next-line no-array-index-key -- composite key needs the index for uniqueness when databaseId is missing
        <div className="flex gap-2" key={`${thread.id}:${comment.id}:${index}`}>
          <ActorAvatar actor={comment.user} />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-muted-foreground">{comment.user?.login ?? "ghost"}</p>
            <GitHubMarkdown>{comment.body}</GitHubMarkdown>
          </div>
        </div>
      ))}
    </>
  );
}

/** Resolve / Fix / Add-to-fix-it-list buttons for a thread. */
// fallow-ignore-next-line code-duplication -- param-destructuring shape shared with unrelated components (WorktreeRowActions, WorktreeContextMenu); not extractable logic.
function ReviewThreadActions({
  thread,
  busy,
  onFixItList,
  onToggleResolved,
  onFix,
  onToggleFixItList,
}: {
  thread: ReviewThread;
  busy: boolean;
  onFixItList: boolean;
  onToggleResolved: () => void;
  onFix: (comment: FixItComment) => void;
  onToggleFixItList: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={busy} onClick={onToggleResolved} size="sm" variant="outline">
        {busy ? <Loader2 className="animate-spin" /> : null}
        {thread.isResolved ? "Unresolve" : "Resolve"}
      </Button>
      <Button onClick={() => onFix(reviewThreadToFixItComment(thread))} size="sm">
        <Sparkles />
        Fix
      </Button>
      <Button onClick={onToggleFixItList} size="sm" variant={onFixItList ? "secondary" : "outline"}>
        {onFixItList ? <Check /> : <ListChecks />}
        {onFixItList ? "On fix it list" : "Add to fix it list"}
      </Button>
    </div>
  );
}

/**
 * A compact inline review thread with a Resolve / Unresolve toggle; resolved
 * threads dim. The toggle updates **optimistically** via `onResolvedChange` —
 * the parent flips the thread's state in place without a refetch — and only
 * surfaces a toast when the GitHub mutation actually fails, reverting the
 * optimistic flip so the UI matches the server again.
 *
 * Two fix affordances sit beside Resolve: **Fix** opens a dialog (via `onFix`) to
 * launch an agent on just this comment, and **Add to fix it list** flags it for a
 * later batch fix (`fix-it-store`), toggling back off if already flagged.
 */
function ReviewThreadCard({
  thread,
  prNumber,
  onFix,
  onResolvedChange,
}: {
  thread: ReviewThread;
  prNumber: number;
  onFix: (comment: FixItComment) => void;
  onResolvedChange: (threadId: string, isResolved: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(thread.isResolved);
  const onFixItList = useIsFixItComment(prNumber, thread.id);

  const toggleFixItList = useCallback(() => {
    if (onFixItList) {
      removeFixItComment(prNumber, thread.id);
    } else {
      addFixItComment(prNumber, reviewThreadToFixItComment(thread));
      toast.success("Added to fix it list");
    }
  }, [onFixItList, prNumber, thread]);

  const toggleResolved = useCallback(async () => {
    const next = !thread.isResolved;
    setBusy(true);
    onResolvedChange(thread.id, next); // optimistic
    try {
      await (next ? resolveReviewThread(thread.id) : unresolveReviewThread(thread.id));
    } catch (cause) {
      onResolvedChange(thread.id, !next); // revert on failure
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [thread.id, thread.isResolved, onResolvedChange]);

  return (
    <div
      className={`rounded-md border border-border bg-canvas p-2 ${thread.isResolved ? "opacity-60" : ""}`}
    >
      <ReviewThreadHeader
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        thread={thread}
      />
      {collapsed ? null : (
        <div className="mt-2 flex flex-col gap-2">
          <ReviewThreadComments thread={thread} />
          <ReviewThreadActions
            busy={busy}
            onFix={onFix}
            onFixItList={onFixItList}
            onToggleFixItList={toggleFixItList}
            onToggleResolved={() => void toggleResolved()}
            thread={thread}
          />
        </div>
      )}
    </div>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      className={`flex h-full items-center justify-center bg-canvas p-6 text-center text-sm ${
        tone === "error" ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {children}
    </div>
  );
}
