import { describe, expect, it, vi } from "vitest";

import { centeringDelta, settleCommentIntoView } from "./review-scroll";

/** A scrollable element whose scrollTop clamps like a browser's. */
function scroller(max: number): HTMLElement {
  const el = document.createElement("div");
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, max));
    },
  });
  return el;
}

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height } as DOMRect;
}

/**
 * A review scroller (viewport 0–800, a 36px sticky toolbar) holding one file:
 * a 30px header over a 320px diff pane at content offset 2000. The comment sits
 * 1000px into the diff and only exists once the diff has been "revealed" — the
 * way a virtualized CodeMirror line only renders once scrolled to.
 */
function fixture({ paneHeight = 320, commentHeight = 100 } = {}) {
  const outer = scroller(10_000);
  const inner = scroller(5_000);
  const node = document.createElement("div");
  let revealed = false;
  const paneOffset = 2030;
  const innerTop = () => paneOffset - outer.scrollTop;

  outer.getBoundingClientRect = () => rect(0, 800);
  inner.getBoundingClientRect = () => rect(innerTop(), paneHeight);
  node.getBoundingClientRect = () => rect(innerTop() + 1000 - inner.scrollTop, commentHeight);

  const target = {
    reveal: vi.fn(() => {
      if (!revealed) {
        revealed = true;
        inner.append(node);
        // CodeMirror's first estimate of the line's position is off.
        inner.scrollTop = 600;
      }
    }),
    scroller: () => inner,
    block: () => ({ top: innerTop() - 30, bottom: innerTop() + paneHeight }),
  };

  const frames: (() => void)[] = [];
  const settle = () =>
    settleCommentIntoView({
      outer,
      topInset: 36,
      findNode: () => (revealed ? node : null),
      target,
      schedule: (callback) => frames.push(callback),
      cancel: () => {
        frames.length = 0;
      },
      now: () => 0,
    });
  const runFrames = () => {
    let count = 0;
    while (frames.length > 0 && count < 50) {
      frames.shift()?.();
      count += 1;
    }
    return count;
  };
  return { outer, inner, node, target, settle, runFrames, frames, innerTop };
}

describe("centeringDelta", () => {
  it("centers a target that fits in the band", () => {
    expect(centeringDelta({ top: 500, bottom: 600 }, { top: 0, bottom: 800 })).toBe(150);
  });

  it("top-aligns (with a margin) a target taller than the band", () => {
    expect(centeringDelta({ top: 500, bottom: 1500 }, { top: 100, bottom: 800 })).toBe(384);
  });
});

describe("settleCommentIntoView", () => {
  it("centers the comment in its diff and the file on screen, then stops", () => {
    const { outer, inner, node, settle, runFrames, frames, innerTop } = fixture();
    settle();
    runFrames();

    expect(frames).toHaveLength(0);
    const commentCenter =
      (node.getBoundingClientRect().top + node.getBoundingClientRect().bottom) / 2;
    expect(commentCenter).toBeCloseTo(innerTop() + 160);
    // File block (header + pane) centered in the band below the toolbar.
    const blockCenter = (innerTop() - 30 + innerTop() + 320) / 2;
    expect(blockCenter).toBeCloseTo((36 + 800) / 2);
    expect(inner.scrollTop).toBe(890);
    expect(outer.scrollTop).toBe(1757);
  });

  it("centers the comment itself when the pane is taller than the screen", () => {
    const { node, settle, runFrames } = fixture({ paneHeight: 2000 });
    settle();
    runFrames();
    const { top, bottom } = node.getBoundingClientRect();
    expect((top + bottom) / 2).toBeCloseTo((36 + 800) / 2);
  });

  it("keeps revealing until the virtualized comment mounts", () => {
    const { target, settle, runFrames } = fixture();
    settle();
    runFrames();
    expect(target.reveal).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting past the settle budget for a slow diff to mount", () => {
    const outer = scroller(10_000);
    const node = document.createElement("div");
    outer.getBoundingClientRect = () => rect(0, 800);
    node.getBoundingClientRect = () => rect(3000 - outer.scrollTop, 60);
    let clock = 0;
    let mounted = false;
    const frames: (() => void)[] = [];
    settleCommentIntoView({
      outer,
      topInset: 36,
      findNode: () => (mounted ? node : null),
      target: null,
      schedule: (callback) => frames.push(callback),
      cancel: () => {
        frames.length = 0;
      },
      now: () => clock,
    });
    // The git request and render take longer than the 3s settle budget.
    for (let tick = 0; tick < 10; tick += 1) {
      clock += 500;
      frames.shift()?.();
    }
    expect(frames.length).toBeGreaterThan(0);
    mounted = true;
    while (frames.length > 0) {
      clock += 16;
      frames.shift()?.();
    }
    const { top, bottom } = node.getBoundingClientRect();
    expect((top + bottom) / 2).toBeCloseTo((36 + 800) / 2);
  });

  it("stops as soon as the user scrolls", () => {
    const { outer, settle, frames } = fixture();
    settle();
    expect(frames.length).toBeGreaterThan(0);
    outer.dispatchEvent(new Event("wheel"));
    expect(frames).toHaveLength(0);
  });

  it("centers a file-level comment (no diff target) in the review scroller", () => {
    const outer = scroller(10_000);
    const node = document.createElement("div");
    outer.getBoundingClientRect = () => rect(0, 800);
    node.getBoundingClientRect = () => rect(3000 - outer.scrollTop, 60);
    const frames: (() => void)[] = [];
    settleCommentIntoView({
      outer,
      topInset: 36,
      findNode: () => node,
      target: null,
      schedule: (callback) => frames.push(callback),
      cancel: () => undefined,
      now: () => 0,
    });
    while (frames.length > 0) {
      frames.shift()?.();
    }
    const { top, bottom } = node.getBoundingClientRect();
    expect((top + bottom) / 2).toBeCloseTo((36 + 800) / 2);
  });
});
