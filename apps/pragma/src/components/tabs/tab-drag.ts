import type { SplitDirection, SplitPlacement } from "@/state/workspace-context";

/** Custom drag MIME type carrying a tab id between the tab strip and split panes. */
export const TAB_DRAG_TYPE = "application/x-pragma-tab-id";

/** Marks a pane's outer element with its id, so a drag can be resolved by geometry. */
export const PANE_ID_ATTR = "data-pane-id";
/** Marks a pane's tab bar inside that pane: the band where a drop merges instead of splits. */
export const PANE_BAR_ATTR = "data-pane-bar";

/**
 * Where a tab dropped onto a pane's content will land: a split toward the nearest
 * edge, plus the highlight rectangle (CSS inset values) that previews it. Dropping
 * on a pane's content always splits — to merge a tab into a pane instead, drop it
 * on that pane's tab bar.
 */
export interface DropTarget {
  direction: SplitDirection;
  placement: SplitPlacement;
  highlight: { left: string; top: string; right: string; bottom: string };
}

/** A pane's on-screen geometry, as read from the DOM for drag resolution. */
export interface PaneGeometry {
  paneId: string;
  /** The whole pane, tab bar included — a split divides all of it. */
  rect: DOMRect;
  /** The pane's own tab bar, when it has one (only split layouts do). */
  barRect: DOMRect | null;
}

/** What a drop at the current pointer position would do. `split: null` means merge. */
export interface PaneDropIntent {
  paneId: string;
  split: DropTarget | null;
}

const FULL = { left: "0%", top: "0%", right: "0%", bottom: "0%" } as const;

function clamp01(value: number): number {
  // A zero-size rect (a pane mid-layout, or jsdom) divides to NaN; treat that as
  // the center so the caller still gets a deterministic split rather than one
  // decided by NaN comparisons all being false.
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function containsPoint(rect: DOMRect, clientX: number, clientY: number): boolean {
  return (
    clientX >= rect.left &&
    clientX < rect.right &&
    clientY >= rect.top &&
    clientY < rect.bottom &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * Resolves a pointer position over a pane into a split toward the nearest edge.
 * The pane is divided into four quadrants by its diagonals; whichever quadrant the
 * pointer falls in picks the split direction and side, so every spot on the pane
 * previews a split (there is no merge/center zone). `highlight` previews the half
 * the dropped tab will occupy.
 */
export function dropTargetAt(rect: DOMRect, clientX: number, clientY: number): DropTarget {
  const x = clamp01((clientX - rect.left) / rect.width);
  const y = clamp01((clientY - rect.top) / rect.height);
  const distances = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  const nearest = Math.min(distances.left, distances.right, distances.top, distances.bottom);

  if (nearest === distances.left) {
    return { direction: "horizontal", placement: "before", highlight: { ...FULL, right: "50%" } };
  }
  if (nearest === distances.right) {
    return { direction: "horizontal", placement: "after", highlight: { ...FULL, left: "50%" } };
  }
  if (nearest === distances.top) {
    return { direction: "vertical", placement: "before", highlight: { ...FULL, bottom: "50%" } };
  }
  return { direction: "vertical", placement: "after", highlight: { ...FULL, top: "50%" } };
}

/**
 * Picks the pane under the pointer and what dropping there would do. Split geometry
 * is measured against the whole pane (its tab bar included), because that is what a
 * split actually divides; the bar band itself merges instead.
 */
export function resolvePaneDropIntent(
  panes: PaneGeometry[],
  clientX: number,
  clientY: number,
): PaneDropIntent | null {
  const hit = panes.find((pane) => containsPoint(pane.rect, clientX, clientY));
  if (!hit) {
    return null;
  }
  if (hit.barRect && containsPoint(hit.barRect, clientX, clientY)) {
    return { paneId: hit.paneId, split: null };
  }
  return { paneId: hit.paneId, split: dropTargetAt(hit.rect, clientX, clientY) };
}

/** Reads every mounted pane's geometry, newest layout, for drag resolution. */
export function readPaneGeometry(root: ParentNode = document): PaneGeometry[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${PANE_ID_ATTR}]`)).flatMap((element) => {
    const paneId = element.getAttribute(PANE_ID_ATTR);
    if (!paneId) {
      return [];
    }
    const bar = element.querySelector<HTMLElement>(`[${PANE_BAR_ATTR}]`);
    return [
      {
        paneId,
        rect: element.getBoundingClientRect(),
        barRect: bar?.getBoundingClientRect() ?? null,
      },
    ];
  });
}
