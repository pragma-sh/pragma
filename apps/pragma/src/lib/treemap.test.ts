import { describe, expect, it } from "vitest";

import { squarify, type TreemapTile } from "./treemap";

const BOUNDS = { x: 0, y: 0, width: 600, height: 400 };

function area(tile: TreemapTile<unknown>): number {
  return tile.width * tile.height;
}

describe("squarify", () => {
  it("fills the bounds with areas proportional to value", () => {
    const tiles = squarify(
      [6, 6, 4, 3, 2, 2, 1].map((value) => ({ value, data: value })),
      BOUNDS,
    );
    expect(tiles).toHaveLength(7);
    const total = tiles.reduce((sum, tile) => sum + area(tile), 0);
    expect(total).toBeCloseTo(600 * 400, 6);
    for (const tile of tiles) {
      expect(area(tile)).toBeCloseTo((tile.data / 24) * 600 * 400, 6);
    }
  });

  it("keeps every tile inside the bounds", () => {
    const tiles = squarify(
      Array.from({ length: 40 }, (_, index) => ({ value: (index % 7) + 1, data: index })),
      { x: 10, y: 20, width: 300, height: 90 },
    );
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(tile.y).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(tile.x + tile.width).toBeLessThanOrEqual(310 + 1e-9);
      expect(tile.y + tile.height).toBeLessThanOrEqual(110 + 1e-9);
    }
  });

  it("produces near-square tiles for equal values", () => {
    const tiles = squarify(
      Array.from({ length: 4 }, (_, index) => ({ value: 1, data: index })),
      { x: 0, y: 0, width: 200, height: 200 },
    );
    for (const tile of tiles) {
      expect(Math.max(tile.width / tile.height, tile.height / tile.width)).toBeLessThan(1.01);
    }
  });

  it("drops empty values and degenerate bounds", () => {
    expect(squarify([{ value: 0, data: "a" }], BOUNDS)).toEqual([]);
    expect(squarify([{ value: 1, data: "a" }], { x: 0, y: 0, width: 0, height: 10 })).toEqual([]);
    expect(
      squarify(
        [
          { value: -1, data: "a" },
          { value: 2, data: "b" },
        ],
        BOUNDS,
      ).map((tile) => tile.data),
    ).toEqual(["b"]);
  });
});
