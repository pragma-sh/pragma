/**
 * Touch scrolling that never reaches the PTY.
 *
 * xterm turns a finger drag into *input*: mouse-wheel reports when the program
 * has mouse tracking on, and ↑/↓ key presses in the alternate screen. On a
 * desktop that is what a wheel should do, but on a phone a swipe is how you
 * read, and every swipe over a TUI typed escape sequences — or stray history
 * navigation — into the agent. Here a swipe only moves the local scrollback.
 */

/** Pixels a swipe must travel before it counts as a drag rather than a tap. */
const DRAG_THRESHOLD_PX = 6;
/** Velocity (px/ms) below which a fling stops coasting. */
const MIN_FLING_VELOCITY = 0.02;
/** Per-frame (16ms) decay of a fling's velocity. */
const FLING_DECAY = 0.95;

/** Turns pixel deltas into whole-line scrolls, carrying the remainder. */
export interface LineAccumulator {
  /** Adds a finger movement (positive = finger moved down) and returns lines to scroll. */
  push: (deltaY: number) => number;
  reset: () => void;
}

/**
 * Accumulates finger movement into lines. Dragging down reveals earlier output,
 * so a positive delta scrolls a negative number of lines.
 */
export function createLineAccumulator(lineHeight: () => number): LineAccumulator {
  let carried = 0;
  return {
    push(deltaY) {
      const height = lineHeight();
      if (!(height > 0)) return 0;
      carried -= deltaY;
      // `| 0` rather than `Math.trunc`: no negative zero for "no lines yet".
      const lines = (carried / height) | 0;
      carried -= lines * height;
      return lines;
    },
    reset() {
      carried = 0;
    },
  };
}

/**
 * Takes over touch scrolling for `root`.
 *
 * The listeners sit in the capture phase on `window`, ahead of xterm's own
 * gesture recogniser (which listens on `document`), and stop every touch inside
 * the terminal there — that recogniser exists only to turn swipes into input.
 * Taps still focus the terminal and open links, because those arrive as the
 * mouse events the browser synthesizes afterwards, and default handling is only
 * prevented for a drag, so long-press selection keeps working too.
 */
export function bindTouchScroll(
  root: HTMLElement,
  options: { lineHeight: () => number; scrollLines: (lines: number) => void },
): void {
  const accumulator = createLineAccumulator(options.lineHeight);
  let lastY: number | null = null;
  let startY = 0;
  let dragging = false;
  let velocity = 0;
  let lastTime = 0;
  let fling = 0;

  const stopFling = (): void => {
    if (fling) cancelAnimationFrame(fling);
    fling = 0;
  };
  const scrollBy = (deltaY: number): void => {
    const lines = accumulator.push(deltaY);
    if (lines !== 0) options.scrollLines(lines);
  };
  const coast = (from: number): void => {
    const step = (now: number): void => {
      const elapsed = now - from;
      from = now;
      velocity *= FLING_DECAY ** (elapsed / 16);
      if (Math.abs(velocity) < MIN_FLING_VELOCITY) {
        fling = 0;
        return;
      }
      scrollBy(velocity * elapsed);
      fling = requestAnimationFrame(step);
    };
    fling = requestAnimationFrame(step);
  };

  const inside = (event: TouchEvent): boolean =>
    event.target instanceof Node && root.contains(event.target);

  window.addEventListener(
    "touchstart",
    (event) => {
      if (!inside(event) || event.touches.length !== 1) return;
      stopFling();
      accumulator.reset();
      startY = lastY = event.touches[0]?.clientY ?? 0;
      lastTime = event.timeStamp;
      velocity = 0;
      dragging = false;
      event.stopPropagation();
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    "touchmove",
    (event) => {
      if (lastY === null || !inside(event)) return;
      event.stopPropagation();
      const y = event.touches[0]?.clientY ?? lastY;
      if (!dragging && Math.abs(y - startY) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      event.preventDefault();
      const deltaY = y - lastY;
      const elapsed = Math.max(event.timeStamp - lastTime, 1);
      velocity = deltaY / elapsed;
      lastY = y;
      lastTime = event.timeStamp;
      scrollBy(deltaY);
    },
    { capture: true, passive: false },
  );
  const end = (event: TouchEvent): void => {
    if (lastY === null) return;
    event.stopPropagation();
    lastY = null;
    if (!dragging) return;
    dragging = false;
    coast(performance.now());
  };
  window.addEventListener("touchend", end, { capture: true });
  window.addEventListener("touchcancel", end, { capture: true });
}
