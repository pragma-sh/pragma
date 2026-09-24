import { squarify, type TreemapRect } from "@/lib/treemap";

import type { StorageNode } from "./storage-model";

/**
 * Pure placement for the storage treemap: which boxes are drawn where, and —
 * for each box — what a click zooms into.
 */

/** One drawn box: a top-level folder, a worktree's root files, or a pending worktree. */
export interface Leaf {
  node: StorageNode;
  rect: TreemapRect;
  /** One zoom step toward this box: the view's direct child under it (scroll wheel). */
  region: StorageNode | null;
  /**
   * What a click zooms into: the innermost box with something inside to show
   * (a worktree or project). Null when that is already the view.
   */
  clickTarget: StorageNode | null;
}

/** Every drawn box, plus the box of every node in view (for zoom animation). */
export interface TreemapLayout {
  leaves: Leaf[];
  boxes: Map<string, TreemapRect>;
  /** The outer box of every project in view, framed so projects read as separate. */
  frames: TreemapRect[];
}

/**
 * Black gutter kept inside each project's box. Folders pack edge to edge, so
 * without it one project's tiles run straight into the next one's; the frame
 * line is drawn in the middle of this gutter.
 */
export const PROJECT_GUTTER = 4;

/** Whether zooming into a box would show anything more than the box itself. */
export function isZoomable(node: StorageNode): boolean {
  return node.children.length > 0;
}

/** Lays the view's nodes out inside `bounds`. */
export function layoutTreemap(nodes: readonly StorageNode[], bounds: TreemapRect): TreemapLayout {
  const layout: TreemapLayout = { leaves: [], boxes: new Map(), frames: [] };
  place(nodes, bounds, [], layout);
  return layout;
}

function place(
  nodes: readonly StorageNode[],
  bounds: TreemapRect,
  ancestry: readonly StorageNode[],
  layout: TreemapLayout,
): void {
  const tiles = squarify(
    nodes.map((node) => ({ value: node.bytes, data: node })),
    bounds,
  );
  for (const tile of tiles) {
    layout.boxes.set(tile.data.id, tile);
    const chain = [...ancestry, tile.data];
    if (tile.data.children.length > 0) {
      const framed = tile.data.kind === "project" ? inset(tile, PROJECT_GUTTER) : null;
      if (framed) layout.frames.push(tile);
      place(tile.data.children, framed ?? tile, chain, layout);
      continue;
    }
    const top = chain[0] ?? tile.data;
    layout.leaves.push({
      node: tile.data,
      rect: tile,
      region: isZoomable(top) ? top : null,
      clickTarget: chain.findLast(isZoomable) ?? null,
    });
  }
}

/** `rect` shrunk by `gap` on every side, or null when too small to keep any room. */
function inset(rect: TreemapRect, gap: number): TreemapRect | null {
  if (rect.width <= gap * 4 || rect.height <= gap * 4) return null;
  return {
    x: rect.x + gap,
    y: rect.y + gap,
    width: rect.width - gap * 2,
    height: rect.height - gap * 2,
  };
}

/** The box under a point, if any. */
export function leafAt(leaves: readonly Leaf[], x: number, y: number): Leaf | null {
  for (const leaf of leaves) {
    const { rect } = leaf;
    if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) {
      return leaf;
    }
  }
  return null;
}
