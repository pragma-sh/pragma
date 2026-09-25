import { useCallback, useEffect, useRef, useState } from "react";

import type { FileDiff } from "@pragma-sh/constants";

import { type DiffComment, type MergeDiffHandle, MergeDiff } from "@/components/editor/MergeDiff";
import { REVIEW_REFRESH_INTERVAL_MS } from "@/components/github/review-data";
import type { ReviewCommentTarget } from "@/components/github/review-scroll";
import { startRefreshLoop } from "@/components/right-sidebar/refresh-loop";
import { clampHeight, useVerticalResize } from "@/hooks/use-vertical-resize";
import { errorMessage } from "@/lib/errors";
import { subscribeGitHubCache } from "@/lib/github-cache";
import type { PullFile } from "@/lib/github";
import { fileDiffsEqual, loadPrFileDiff, prFileDiffCacheKey } from "@/lib/pr-file-diff";

/** A diff pane's height until the user drags it (matches the former fixed `h-80`). */
export const DEFAULT_DIFF_PANE_HEIGHT_PX = 320;
/** The shortest a diff pane can be dragged. */
const MIN_DIFF_PANE_HEIGHT_PX = 120;
/** How far outside the viewport a pane starts loading (and keeps polling). */
const NEAR_VIEWPORT_MARGIN = "640px 0px";

/**
 * Tracks whether the pane is near the viewport. `mounted` latches the first
 * time it is (or when navigation forces it), so a diff is only ever loaded and
 * rendered once somebody could see it; `near` stays live so only on-screen
 * diffs keep polling git.
 */
function useDiffVisibility(wrapperRef: React.RefObject<HTMLDivElement | null>) {
  const [noObserver] = useState(() => typeof IntersectionObserver === "undefined");
  const [near, setNear] = useState(noObserver);
  const [mounted, setMounted] = useState(noObserver);
  const mount = useCallback(() => setMounted(true), []);

  useEffect(() => {
    const element = wrapperRef.current;
    if (noObserver || !element) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry) {
          return;
        }
        setNear(entry.isIntersecting);
        if (entry.isIntersecting) {
          setMounted(true);
        }
      },
      { rootMargin: NEAR_VIEWPORT_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [noObserver, wrapperRef]);

  return { mounted, near, mount };
}

/**
 * Loads (and keeps fresh) a single file's local `base...HEAD` diff. `enabled`
 * gates everything; `polling` gates only the interval refresh — each tick of it
 * runs git on the host, so a large PR must not refresh every diff the reviewer
 * has already scrolled past.
 */
function useFileDiff(
  worktreeId: string,
  base: string,
  file: PullFile,
  enabled: boolean,
  polling: boolean,
): { diff: FileDiff | null; error: string | null } {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped whenever the loader changes or the pane unmounts, so a response that
  // lands afterwards is dropped instead of painting a stale file.
  const generation = useRef(0);
  const hasDiff = useRef(false);

  const loadDiff = useCallback(async () => {
    const current = generation.current;
    try {
      const result = await loadPrFileDiff(worktreeId, base, file.path, file.oldPath);
      if (current !== generation.current) {
        return;
      }
      hasDiff.current = true;
      setError(null);
      setDiff((prev) => (fileDiffsEqual(prev, result) ? prev : result));
    } catch (cause) {
      if (current === generation.current && !hasDiff.current) {
        setError(errorMessage(cause));
      }
    }
  }, [worktreeId, base, file.path, file.oldPath]);

  useEffect(() => {
    hasDiff.current = false;
    return () => {
      generation.current += 1;
    };
  }, [loadDiff]);

  // Poll while visible — and until the first diff (or error) arrives, so a pane
  // that navigation mounted off-screen still loads.
  const shouldPoll = enabled && (polling || (diff === null && error === null));
  useEffect(() => {
    if (!shouldPoll) {
      return;
    }
    return startRefreshLoop(loadDiff, REVIEW_REFRESH_INTERVAL_MS);
  }, [shouldPoll, loadDiff]);

  // Background revalidate of this file's cache key updates the pane immediately.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const key = prFileDiffCacheKey(worktreeId, base, file.path, file.oldPath);
    return subscribeGitHubCache(key, () => {
      void loadDiff();
    });
  }, [enabled, worktreeId, base, file.path, file.oldPath, loadDiff]);

  return { diff, error };
}

/**
 * Registers a {@link ReviewCommentTarget} per inline comment so toolbar
 * navigation can reach comments in a virtualized — or not yet mounted — diff.
 */
function useCommentTargets(
  comments: DiffComment[],
  registerCommentTarget: (key: string, target: ReviewCommentTarget | null) => void,
  diffRef: React.RefObject<MergeDiffHandle | null>,
  wrapperRef: React.RefObject<HTMLDivElement | null>,
  headerRef: React.RefObject<HTMLElement | null>,
  mount: () => void,
): void {
  useEffect(() => {
    const block = () => {
      const wrapper = wrapperRef.current;
      if (!wrapper) {
        return null;
      }
      const rect = wrapper.getBoundingClientRect();
      // The header's natural height, not its rect: while stuck to the top of the
      // scroller it sits elsewhere than directly above the pane.
      return { top: rect.top - (headerRef.current?.offsetHeight ?? 0), bottom: rect.bottom };
    };
    const scroller = () => diffRef.current?.scroller() ?? null;
    for (const comment of comments) {
      registerCommentTarget(comment.key, {
        reveal: () => {
          if (!diffRef.current?.revealComment(comment.key)) {
            mount();
          }
        },
        scroller,
        block,
      });
    }
    return () => {
      for (const comment of comments) {
        registerCommentTarget(comment.key, null);
      }
    };
  }, [comments, registerCommentTarget, diffRef, wrapperRef, headerRef, mount]);
}

/**
 * Whether the pane owns wheel scrolling. Until the user clicks into it the diff
 * is `overflow: hidden`, so the wheel chains straight to the review scroller —
 * natively, on the compositor, with no per-event JavaScript. Clicking in makes
 * it scrollable; leaving the pane hands the wheel back.
 */
function usePaneEngagement() {
  const [engaged, setEngaged] = useState(false);
  return {
    engaged,
    handlers: {
      onPointerDown: () => setEngaged(true),
      onPointerLeave: () => setEngaged(false),
    },
  };
}

/** Drag bar under a diff pane; double-click toggles between fit-to-content and the default. */
function PaneResizeHandle({
  height,
  onResize,
  contentHeight,
  fileName,
}: {
  height: number;
  onResize: (height: number) => void;
  contentHeight: () => number | null;
  fileName: string;
}) {
  const max = () => Math.max(MIN_DIFF_PANE_HEIGHT_PX, contentHeight() ?? Number.POSITIVE_INFINITY);
  const props = useVerticalResize({ height, min: MIN_DIFF_PANE_HEIGHT_PX, max, onResize });
  return (
    <div
      {...props}
      aria-label={`Resize diff for ${fileName}`}
      className="group/resize flex h-2 cursor-row-resize items-center justify-center border-t border-border bg-elevated outline-none hover:bg-accent focus-visible:bg-accent"
      data-review-pane-resize
      onDoubleClick={() => {
        const natural = contentHeight();
        if (natural === null) {
          return;
        }
        const fit = clampHeight(natural, MIN_DIFF_PANE_HEIGHT_PX, Number.POSITIVE_INFINITY);
        onResize(Math.round(height) < Math.round(fit) ? fit : DEFAULT_DIFF_PANE_HEIGHT_PX);
      }}
    >
      <span className="h-0.5 w-8 rounded-full bg-border group-hover/resize:bg-muted-foreground" />
    </div>
  );
}

/** Props for {@link FileDiffPane}. */
interface FileDiffPaneProps {
  base: string;
  comments: DiffComment[];
  file: PullFile;
  /** The file's sticky header, whose height belongs to the block that navigation centers. */
  headerRef: React.RefObject<HTMLElement | null>;
  /** Owned by the file section so a dragged height survives collapsing the diff. */
  height: number;
  onHeightChange: (height: number) => void;
  registerCommentTarget: (key: string, target: ReviewCommentTarget | null) => void;
  worktreeId: string;
}

/** The pane body for each load state; the diff itself only once it has loaded. */
function DiffPaneContent({
  comments,
  diff,
  error,
  fileName,
  diffRef,
}: {
  comments: DiffComment[];
  diff: FileDiff | null;
  error: string | null;
  fileName: string;
  diffRef: React.RefObject<MergeDiffHandle | null>;
}) {
  if (error) {
    return <p className="px-3 py-2 text-xs text-destructive">{error}</p>;
  }
  if (!diff) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">Loading diff…</p>;
  }
  if (diff.binary) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">Binary file — no diff.</p>;
  }
  return (
    <MergeDiff
      className="overflow-hidden group-data-[engaged]/pane:overflow-auto"
      comments={comments}
      fileName={fileName}
      newText={diff.newText}
      oldText={diff.oldText}
      ref={diffRef}
    />
  );
}

/**
 * Lazily loads + renders a single file's local `base...HEAD` diff in a pane the
 * reviewer can resize by dragging its bottom edge. The pane keeps its height in
 * every state (loading / error / diff), so files below never jump while diffs
 * above them load.
 */
export function FileDiffPane(props: FileDiffPaneProps) {
  const { comments, file, height } = props;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<MergeDiffHandle>(null);
  const { mounted, near, mount } = useDiffVisibility(wrapperRef);
  const { diff, error } = useFileDiff(props.worktreeId, props.base, file, mounted, near);
  const { engaged, handlers } = usePaneEngagement();
  useCommentTargets(
    comments,
    props.registerCommentTarget,
    diffRef,
    wrapperRef,
    props.headerRef,
    mount,
  );

  return (
    <div data-review-diff-pane ref={wrapperRef}>
      <div
        className="group/pane min-h-0"
        data-engaged={engaged ? "" : undefined}
        style={{ height }}
        {...handlers}
      >
        <DiffPaneContent
          comments={comments}
          diff={mounted ? diff : null}
          diffRef={diffRef}
          error={error}
          fileName={file.path}
        />
      </div>
      <PaneResizeHandle
        contentHeight={() => diffRef.current?.contentHeight() ?? null}
        fileName={file.path}
        height={height}
        onResize={props.onHeightChange}
      />
    </div>
  );
}
