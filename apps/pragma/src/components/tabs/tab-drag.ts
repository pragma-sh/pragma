import type { SplitDirection, SplitPlacement } from "@/state/workspace-context";

/** Custom drag MIME type carrying a tab id between the tab strip and split panes. */
export const TAB_DRAG_TYPE = "application/x-pragma-tab-id";

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

const FULL = { left: "0%", top: "0%", right: "0%", bottom: "0%" } as const;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
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
