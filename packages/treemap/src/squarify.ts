/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk, 2000) — the layout
 * GrandPerspective and most disk-usage viewers use. Rectangles are placed in
 * rows along the shorter side of the remaining space, and a row is closed as
 * soon as adding the next item would make its worst aspect ratio worse, which
 * keeps boxes close to square and therefore readable at a glance.
 *
 * Pure geometry: no DOM, no React. Callers nest it themselves by laying out
 * children inside a parent's rectangle.
 */

/** An axis-aligned rectangle in caller units (pixels, usually). */
export interface TreemapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One weighted item to place. Non-positive values are dropped. */
export interface TreemapItem<T> {
  value: number;
  data: T;
}

/** One placed item. */
export interface TreemapTile<T> extends TreemapRect {
  data: T;
}

/** Lays `items` out inside `bounds`, largest first, filling it exactly. */
export function squarify<T>(
  items: readonly TreemapItem<T>[],
  bounds: TreemapRect,
): TreemapTile<T>[] {
  const sorted = items
    .filter((item) => item.value > 0 && Number.isFinite(item.value))
    .toSorted((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0 || bounds.width <= 0 || bounds.height <= 0) return [];

  const scale = (bounds.width * bounds.height) / total;
  const areas = sorted.map((item) => item.value * scale);
  const tiles: TreemapTile<T>[] = [];
  let free: TreemapRect = { ...bounds };
  let row: number[] = [];

  for (let index = 0; index < areas.length; ) {
    const side = Math.min(free.width, free.height);
    const candidate = [...row, index];
    if (row.length === 0 || worstRatio(candidate, areas, side) <= worstRatio(row, areas, side)) {
      row = candidate;
      index += 1;
    } else {
      free = placeRow(row, areas, sorted, free, tiles);
      row = [];
    }
  }
  if (row.length > 0) placeRow(row, areas, sorted, free, tiles);
  return tiles;
}

/** The worst (largest) aspect ratio a row of these areas has along `side`. */
function worstRatio(row: readonly number[], areas: readonly number[], side: number): number {
  let sum = 0;
  let max = 0;
  let min = Infinity;
  for (const index of row) {
    const area = areas[index] ?? 0;
    sum += area;
    max = Math.max(max, area);
    min = Math.min(min, area);
  }
  if (sum <= 0 || min <= 0 || side <= 0) return Infinity;
  const sideSquared = side * side;
  const sumSquared = sum * sum;
  return Math.max((sideSquared * max) / sumSquared, sumSquared / (sideSquared * min));
}

/**
 * Places one row along the shorter side of `free` and returns the space left
 * over. A wide space takes a column on its left; a tall one a row on its top.
 */
function placeRow<T>(
  row: readonly number[],
  areas: readonly number[],
  items: readonly TreemapItem<T>[],
  free: TreemapRect,
  tiles: TreemapTile<T>[],
): TreemapRect {
  const sum = row.reduce((total, index) => total + (areas[index] ?? 0), 0);
  const vertical = free.width >= free.height;
  const thickness = vertical ? sum / free.height : sum / free.width;
  let offset = 0;
  for (const index of row) {
    const item = items[index];
    if (!item) continue;
    const length = (areas[index] ?? 0) / thickness;
    tiles.push(
      vertical
        ? { x: free.x, y: free.y + offset, width: thickness, height: length, data: item.data }
        : { x: free.x + offset, y: free.y, width: length, height: thickness, data: item.data },
    );
    offset += length;
  }
  return vertical
    ? { x: free.x + thickness, y: free.y, width: free.width - thickness, height: free.height }
    : { x: free.x, y: free.y + thickness, width: free.width, height: free.height - thickness };
}
