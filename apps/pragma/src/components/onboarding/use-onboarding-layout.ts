import { useSyncExternalStore } from "react";

/** Width of the fixed copy column beside a step's media panel, in px (28rem). */
const COPY_COLUMN_PX = 448;
/** Aspect ratio of the preview clips; the media panel is sized against it. */
const CLIP_RATIO = 16 / 9;
/** Fractions of the window the dialog may take, per orientation. */
const SIDE_WIDTH_FRACTION = 0.8;
const SIDE_HEIGHT_FRACTION = 0.8;
const STACKED_WIDTH_FRACTION = 0.92;
const STACKED_HEIGHT_FRACTION = 0.88;
/** Caps, so the dialog does not sprawl on a 6K display. */
const SIDE_MAX_WIDTH_PX = 1408;
const STACKED_MAX_WIDTH_PX = 832;
const STACKED_MAX_HEIGHT_PX = 800;
/** Below this the copy column is too short to hold a step's heading and content. */
const MIN_SIDE_HEIGHT_PX = 480;
/** Floor for the stacked dialog, so a short step is not a sliver of banner. */
const MIN_STACKED_HEIGHT_PX = 384;
/**
 * Measured content heights are rounded up to this many pixels before they size
 * the dialog. A step's column settles a pixel or two differently as fonts load,
 * a focus ring appears, or a scrollbar comes and goes; without a step size each
 * of those is a size change, which `layout="size"` animates — and the animation
 * changes the column's width, which changes its height again. Quantising means
 * the common case reports the size it already has, and the dialog holds still.
 */
const HEIGHT_QUANTUM_PX = 16;

/** Where a step's preview clip sits relative to its copy. */
export type OnboardingOrientation = "side" | "stacked";

/** The shape available to the dialog in the current window. */
export interface OnboardingLayout {
  maxHeightPx: number;
  minHeightPx: number;
  orientation: OnboardingOrientation;
  /** Stacked width; unused side by side, where width follows the height. */
  widthPx: number;
}

/** The dialog's actual box, in px. */
export interface OnboardingBox {
  height: number;
  width: number;
}

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

/**
 * How the onboarding dialog may be shaped in a window of this size.
 *
 * Side by side, the clip's panel is `h-full` at 16:9 — it takes its width from
 * the dialog's height — so the widest the dialog may be sets the tallest it may
 * be, and the clip fills its panel edge to edge at every height in between.
 * When even the minimum will not fit (a narrow window, or a short one) the step
 * stacks instead: a full-width banner over the copy, in a narrower dialog.
 */
export function resolveLayout(windowWidth: number, windowHeight: number): OnboardingLayout {
  const sideWidth = Math.min(SIDE_MAX_WIDTH_PX, windowWidth * SIDE_WIDTH_FRACTION);
  const sideMaxHeight = Math.min(
    (sideWidth - COPY_COLUMN_PX) / CLIP_RATIO,
    windowHeight * SIDE_HEIGHT_FRACTION,
  );
  if (sideMaxHeight >= MIN_SIDE_HEIGHT_PX) {
    return {
      maxHeightPx: sideMaxHeight,
      minHeightPx: MIN_SIDE_HEIGHT_PX,
      orientation: "side",
      widthPx: sideWidth,
    };
  }
  const width = Math.min(STACKED_MAX_WIDTH_PX, windowWidth * STACKED_WIDTH_FRACTION);
  const maxHeight = Math.min(STACKED_MAX_HEIGHT_PX, windowHeight * STACKED_HEIGHT_FRACTION);
  return {
    maxHeightPx: maxHeight,
    minHeightPx: Math.min(MIN_STACKED_HEIGHT_PX, maxHeight),
    orientation: "stacked",
    widthPx: width,
  };
}

/**
 * The box for a step whose copy column wants `contentHeight` px (its measured
 * natural height, or `null` before the first measurement).
 *
 * Every number here is an explicit pixel value, deliberately: a `fit-content`
 * width or an `auto` height would be re-derived from the content on every frame
 * of the size animation, and the content reflows as it changes — the dialog
 * then chases itself. Sizing it in one direction only — content, to a box —
 * leaves one discrete change per step for `layout="size"` to animate.
 */
export function dialogBox(layout: OnboardingLayout, contentHeight: number | null): OnboardingBox {
  const content = contentHeight ?? layout.minHeightPx;
  if (layout.orientation === "stacked") {
    // The banner is the dialog's full width at 16:9, and the copy sits under it.
    const height = clamp(
      layout.widthPx / CLIP_RATIO + content,
      layout.minHeightPx,
      layout.maxHeightPx,
    );
    return { height, width: layout.widthPx };
  }
  const height = clamp(content, layout.minHeightPx, layout.maxHeightPx);
  return { height, width: COPY_COLUMN_PX + height * CLIP_RATIO };
}

/** Rounds a measured content height up to the step size the dialog is sized in. */
export function quantizeHeight(px: number) {
  return Math.ceil(px / HEIGHT_QUANTUM_PX) * HEIGHT_QUANTUM_PX;
}

let cached: { height: number; layout: OnboardingLayout; width: number } | null = null;

/** `resolveLayout` for the current window, returning one stable object per size. */
function snapshot(): OnboardingLayout {
  const width = window.innerWidth;
  const height = window.innerHeight;
  // `useSyncExternalStore` compares snapshots by identity, so a fresh object on
  // every read would re-render forever.
  if (!cached || cached.width !== width || cached.height !== height) {
    cached = { height, layout: resolveLayout(width, height), width };
  }
  return cached.layout;
}

const SERVER_LAYOUT = resolveLayout(1600, 1000);

function subscribe(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/**
 * The layout available in the current window, re-read on every resize.
 *
 * The dialog and the step frame both call this: one sizes the box, the other
 * arranges the clip and copy inside it, and both must agree — a side-by-side
 * frame in a stacked-shaped dialog is exactly the squashed panel this avoids.
 */
export function useOnboardingLayout(): OnboardingLayout {
  return useSyncExternalStore(subscribe, snapshot, () => SERVER_LAYOUT);
}
