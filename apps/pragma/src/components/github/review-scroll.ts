/** A vertical span in viewport coordinates. */
export interface VerticalSpan {
  top: number;
  bottom: number;
}

/**
 * What a diff pane registers for each inline comment so toolbar navigation can
 * reach it, even while the diff is virtualized or not yet mounted.
 */
export interface ReviewCommentTarget {
  /**
   * Bring the comment's anchor line into the diff's own viewport — never an
   * ancestor's — mounting a deferred diff first. Positions are estimates until
   * CodeMirror measures the lines, which the settle loop then corrects.
   */
  reveal(): void;
  /** The diff's vertical scroller, or null while the diff is still loading. */
  scroller(): HTMLElement | null;
  /** The file block (sticky header + diff pane) in viewport coordinates. */
  block(): VerticalSpan | null;
}

/** Room kept above a target too tall to center, so its first line isn't flush with the edge. */
const EDGE_MARGIN_PX = 16;
/** Consecutive still frames before a navigation counts as landed. */
const STABLE_FRAMES = 2;
/** Upper bound on correcting — long enough for a cold diff to load and render. */
const SETTLE_BUDGET_MS = 3000;
/** Anything the user does to scroll ends an unfinished settle rather than fighting it. */
const USER_SCROLL_EVENTS = ["wheel", "pointerdown", "touchstart"] as const;

function height(span: VerticalSpan): number {
  return span.bottom - span.top;
}

function spanOf(el: Element): VerticalSpan {
  const rect = el.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
}

/**
 * Walks `keys` from `cursor` in `step` direction (no wrap) and returns the index
 * of the first key `isReachable` accepts, or -1 when there is none.
 */
export function nextReachableIndex(
  keys: readonly string[],
  cursor: number,
  step: 1 | -1,
  isReachable: (key: string) => boolean,
): number {
  for (let index = cursor + step; index >= 0 && index < keys.length; index += step) {
    if (isReachable(keys[index]!)) {
      return index;
    }
  }
  return -1;
}

/**
 * The scroll delta that centers `target` within `band`. A target taller than
 * the band cannot be centered, so its top is aligned just inside the band's top
 * instead: the start of a long comment (or file) is what the reader needs.
 */
export function centeringDelta(target: VerticalSpan, band: VerticalSpan): number {
  if (height(target) > height(band) - 2 * EDGE_MARGIN_PX) {
    return target.top - (band.top + EDGE_MARGIN_PX);
  }
  return (target.top + target.bottom) / 2 - (band.top + band.bottom) / 2;
}

/** Scroll `el` by `delta`; returns how far it actually moved (the browser clamps at both ends). */
function scrollByClamped(el: HTMLElement, delta: number): number {
  const before = el.scrollTop;
  el.scrollTop = before + delta;
  return el.scrollTop - before;
}

/**
 * What to center in the review scroller: the whole file block when it fits on
 * screen, otherwise the comment itself (a pane resized taller than the window
 * can't be centered, but the comment inside it still can).
 */
function outerFocus(
  block: VerticalSpan | null,
  node: HTMLElement | null,
  band: VerticalSpan,
): VerticalSpan | null {
  if (block && height(block) <= height(band) - 2 * EDGE_MARGIN_PX) {
    return block;
  }
  return node ? spanOf(node) : block;
}

/** Options for {@link settleCommentIntoView}. */
export interface SettleOptions {
  /** The review scroll container. */
  outer: HTMLElement;
  /** Height of the sticky chrome pinned to the top of {@link outer}. */
  topInset: number;
  /** The comment's DOM node, once mounted. */
  findNode: () => HTMLElement | null;
  /** The diff-pane target for an inline comment; null for a file-level comment. */
  target: ReviewCommentTarget | null;
  /** Frame scheduler (injectable for tests). */
  schedule?: (callback: () => void) => number;
  /** Cancels a scheduled frame (injectable for tests). */
  cancel?: (handle: number) => void;
  /** Clock (injectable for tests). */
  now?: () => number;
}

/**
 * One correction pass. Returns true once the comment is mounted and neither
 * scroller had to move — i.e. the comment is centered in its diff and the file
 * is centered on screen.
 */
function settleStep({ outer, topInset, findNode, target }: SettleOptions): boolean {
  const node = findNode();
  let placed = node !== null;
  let moved = 0;
  if (target) {
    const inner = target.scroller();
    if (node && inner?.contains(node)) {
      moved += scrollByClamped(inner, centeringDelta(spanOf(node), spanOf(inner)));
    } else {
      target.reveal();
      placed = false;
    }
  }
  const outerSpan = spanOf(outer);
  const band = { top: outerSpan.top + topInset, bottom: outerSpan.bottom };
  const focus = outerFocus(target?.block() ?? null, node, band);
  if (focus) {
    moved += scrollByClamped(outer, centeringDelta(focus, band));
  }
  return placed && Math.abs(moved) < 1;
}

/**
 * Lands a review comment in the middle of its diff pane, and that pane in the
 * middle of the review scroller.
 *
 * The diff is virtualized: line heights below the fold are estimates, and a
 * comment's DOM node only exists once CodeMirror renders its line and React
 * mounts the portal into it. A one-shot (let alone smooth) `scrollIntoView`
 * aims at those estimates and overshoots as the real heights arrive. Instead
 * this re-measures every frame and corrects both scrollers instantly until the
 * comment holds still. Returns a function that stops it early.
 */
export function settleCommentIntoView(options: SettleOptions): () => void {
  const schedule = options.schedule ?? ((callback) => requestAnimationFrame(callback));
  const cancel = options.cancel ?? ((handle) => cancelAnimationFrame(handle));
  const now = options.now ?? (() => performance.now());
  const deadline = now() + SETTLE_BUDGET_MS;
  let stableFrames = 0;
  let frame = 0;
  let stopped = false;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    cancel(frame);
    for (const type of USER_SCROLL_EVENTS) {
      options.outer.removeEventListener(type, stop);
    }
  };
  const step = () => {
    if (stopped) {
      return;
    }
    stableFrames = settleStep(options) ? stableFrames + 1 : 0;
    if (stableFrames >= STABLE_FRAMES || now() > deadline) {
      stop();
      return;
    }
    frame = schedule(step);
  };

  for (const type of USER_SCROLL_EVENTS) {
    options.outer.addEventListener(type, stop, { passive: true });
  }
  step();
  return stop;
}
