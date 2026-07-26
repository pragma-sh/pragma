import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "@/lib/errors";

import type { FileDiff, GitHubRepoRef, Tab } from "@pragma/constants";
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

import { FixCommentDialog } from "@/components/github/FixCommentDialog";
import { FixItListDialog } from "@/components/github/FixItListDialog";
import { GitHubMarkdown } from "@/components/github/GitHubMarkdown";
import { ActorAvatar } from "@/components/github/ViewPullRequestView";
import { type DiffComment, type MergeDiffHandle, MergeDiff } from "@/components/editor/MergeDiff";
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
import { reviewThreadToFixItComment } from "@/lib/fix-it-prompt";
import { githubPrFileDiff, githubRepoRef } from "@/lib/tauri";
import {
  addFixItComment,
  type FixItComment,
  removeFixItComment,
  useFixItComments,
  useIsFixItComment,
} from "@/state/fix-it-store";
import { useReviewDone, setReviewDone } from "@/state/review-done-store";
import { clearReviewFocus, useReviewFocus } from "@/state/review-focus-store";

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

/** Group review threads into a per-path map (file order is preserved by the caller). */
function groupThreadsByPath(threads: ReviewThread[]): Map<string, ReviewThread[]> {
  const map = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    const bucket = map.get(thread.path);
    if (bucket) {
      bucket.push(thread);
    } else {
      map.set(thread.path, [thread]);
    }
  }
  return map;
}

/** Every review thread's id, in file-then-thread order, for toolbar navigation. */
function buildCommentKeys(files: PullFile[], threadsByPath: Map<string, ReviewThread[]>): string[] {
  const keys: string[] = [];
  for (const file of files) {
    for (const thread of threadsByPath.get(file.path) ?? []) {
      keys.push(thread.id);
    }
  }
  return keys;
}

/** Load the PR + files + reviews + threads, and own the optimistic thread-resolve flip. */
function useReviewData(worktreeId: string, prNumber: number | null) {
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
      if (active.current) {
        setState({
          kind: "ready",
          data: { repo, pr, files, reviews, threadsByPath: groupThreadsByPath(threads) },
        });
      }
    } catch (cause) {
      if (active.current) {
        setState({ kind: "error", message: errorMessage(cause) });
      }
    }
  }, [worktreeId, prNumber]);

  // Optimistically flips one thread's resolved state in place — no refetch, so the
  // diff panes and decorations don't flash. Stable (functional update) so each
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

  return { state, setThreadResolved };
}

/** DOM-node registries so focus requests and toolbar arrows can reach file sections and comments. */
function useReviewRegistration() {
  const sectionEls = useRef(new Map<string, HTMLElement>());
  const commentReveal = useRef(new Map<string, () => void>());
  const registerSection = useCallback((path: string, el: HTMLElement | null) => {
    if (el) {
      sectionEls.current.set(path, el);
    } else {
      sectionEls.current.delete(path);
    }
  }, []);
  const registerCommentReveal = useCallback((key: string, reveal: (() => void) | null) => {
    if (reveal) {
      commentReveal.current.set(key, reveal);
    } else {
      commentReveal.current.delete(key);
    }
  }, []);
  return { sectionEls, commentReveal, registerSection, registerCommentReveal };
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
 */
export function ReviewTab({ tab }: { tab: Tab }) {
  const { worktreeId, prNumber } = tab;
  const { state, setThreadResolved } = useReviewData(worktreeId, prNumber);
  const { sectionEls, commentReveal, registerSection, registerCommentReveal } =
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

  if (state.kind === "loading") {
    return <Centered>Loading review…</Centered>;
  }
  if (state.kind === "error") {
    return <Centered tone="error">{state.message}</Centered>;
  }

  const { data } = state;
  const commentKeys = buildCommentKeys(data.files, data.threadsByPath);
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
      <ReviewToolbar
        commentKeys={commentKeys}
        commentReveal={commentReveal}
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
          registerCommentReveal={registerCommentReveal}
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
 * diffs scroll beneath it, and resolves each comment id to its mounted DOM node
 * (collapsed/reviewed files don't render theirs) to scroll it into view.
 */
function ReviewToolbar({
  commentKeys,
  commentReveal,
  prNumber,
  scrollRef,
  onAddressFixIt,
}: {
  commentKeys: string[];
  commentReveal: React.RefObject<Map<string, () => void>>;
  prNumber: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onAddressFixIt: () => void;
}) {
  // Index into `commentKeys` of the comment we last scrolled to; -1 before any
  // navigation so the first "next" lands on the first comment. State (not a ref)
  // so the arrows re-render their disabled state as the cursor moves.
  const [cursor, setCursor] = useState(-1);

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
      // Walk the ordered ids outward from the cursor (no wrap) until we reach a
      // reachable comment: one already mounted, or one whose diff registered a
      // reveal callback. Comments in a collapsed (reviewed) file have neither, so
      // they're skipped.
      const step = direction === "next" ? 1 : -1;
      for (let index = cursor + step; index >= 0 && index < commentKeys.length; index += step) {
        const key = commentKeys[index]!;
        const reveal = commentReveal.current.get(key);
        if (!reveal && !nodeFor(key)) {
          continue;
        }
        setCursor(index);
        // Reveal first (renders the comment's line in the virtualized diff and
        // centers it within the diff pane), then center the now-mounted node in
        // the outer container. Two frames: one for CodeMirror to draw the widget,
        // one for its React portal to mount the comment's DOM node.
        reveal?.();
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            nodeFor(key)?.scrollIntoView({ behavior: "smooth", block: "center" }),
          ),
        );
        return;
      }
    },
    [commentKeys, commentReveal, cursor, scrollRef],
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
    <div className="sticky top-0 z-20 flex h-9 shrink-0 items-center gap-2 border-b border-border bg-elevated px-3">
      <div className="flex items-center gap-0.5">
        <Button
          aria-label="Previous comment"
          disabled={!hasPrev}
          onClick={() => go("prev")}
          size="icon-sm"
          title="Previous comment (⌘/Ctrl ↑)"
          variant="ghost"
        >
          <ChevronUp />
        </Button>
        <Button
          aria-label="Next comment"
          disabled={!hasNext}
          onClick={() => go("next")}
          size="icon-sm"
          title="Next comment (⌘/Ctrl ↓)"
          variant="ghost"
        >
          <ChevronDown />
        </Button>
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

/** One file's review block: header + done toggle, collapsible diff, inline threads. */
function FileReview({
  base,
  file,
  prNumber,
  threads,
  worktreeId,
  onFix,
  onThreadResolvedChange,
  registerCommentReveal,
  registerSection,
}: {
  base: string;
  file: PullFile;
  prNumber: number;
  threads: ReviewThread[];
  worktreeId: string;
  onFix: (comment: FixItComment) => void;
  onThreadResolvedChange: (threadId: string, isResolved: boolean) => void;
  registerCommentReveal: (key: string, reveal: (() => void) | null) => void;
  registerSection: (path: string, el: HTMLElement | null) => void;
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
      <header className="sticky top-9 z-10 flex items-center gap-2 border-b border-border bg-elevated px-3 py-1.5">
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
            registerCommentReveal={registerCommentReveal}
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
}

/** Lazily loads + renders a single file's local `base...HEAD` diff. */
function FileDiffPane({
  base,
  comments,
  file,
  registerCommentReveal,
  worktreeId,
}: {
  base: string;
  comments: DiffComment[];
  file: PullFile;
  registerCommentReveal: (key: string, reveal: (() => void) | null) => void;
  worktreeId: string;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<MergeDiffHandle>(null);

  // Register a reveal callback per inline comment so the toolbar can scroll a
  // below-the-fold comment into the virtualized diff before centering it.
  useEffect(() => {
    for (const comment of comments) {
      registerCommentReveal(comment.key, () => diffRef.current?.scrollCommentIntoView(comment.key));
    }
    return () => {
      for (const comment of comments) {
        registerCommentReveal(comment.key, null);
      }
    };
  }, [comments, registerCommentReveal]);
  // The diff only "captures" wheel scrolling once the user clicks into it. Until
  // then a wheel over the pane is redirected to the review scroll container, so
  // the user can scroll past the file instead of the fixed-height diff trapping
  // the scroll. A ref (not state) keeps the wheel listener from re-subscribing.
  const engaged = useRef(false);

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
          setError(errorMessage(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [worktreeId, base, file.path, file.oldPath]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) {
      return;
    }
    // Non-passive so we can cancel the diff's own scroll and forward it upward.
    const onWheel = (event: WheelEvent) => {
      if (engaged.current) {
        return;
      }
      const scroller = el.closest<HTMLElement>("[data-review-scroll]");
      if (!scroller) {
        return;
      }
      event.preventDefault();
      scroller.scrollTop += event.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  let content: React.ReactNode;
  if (error) {
    content = <p className="px-3 py-2 text-xs text-destructive">{error}</p>;
  } else if (!diff) {
    content = <p className="px-3 py-2 text-xs text-muted-foreground">Loading diff…</p>;
  } else if (diff.binary) {
    content = <p className="px-3 py-2 text-xs text-muted-foreground">Binary file — no diff.</p>;
  } else {
    content = (
      <MergeDiff
        comments={comments}
        fileName={file.path}
        newText={diff.newText}
        oldText={diff.oldText}
        ref={diffRef}
      />
    );
  }

  // A stable `h-80` for every state (loading / error / diff) so a file's height
  // never changes once it mounts — that keeps a pending scroll-into-view request
  // landing on the right file even while diffs above it are still loading.
  return (
    <div
      className="h-80 min-h-0"
      onPointerDown={() => {
        engaged.current = true;
      }}
      onPointerLeave={() => {
        engaged.current = false;
      }}
      ref={wrapperRef}
    >
      {content}
    </div>
  );
}

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
