import { describe, expect, it } from "bun:test";

import { diagonalAngle, layoutStorageCover, STORAGE_COVER_SIZE } from "./storage-cover";

describe("storage cover", () => {
  it("angles each gradient along its box's top-left to bottom-right diagonal", () => {
    expect(diagonalAngle(100, 100)).toBeCloseTo(135);
    expect(diagonalAngle(100, 0)).toBeCloseTo(90);
    expect(diagonalAngle(0, 100)).toBeCloseTo(180);
  });

  it("frames three projects and keeps every tile inside the canvas", () => {
    const { tiles, frames } = layoutStorageCover();
    expect(frames).toHaveLength(3);
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.x + tile.width).toBeLessThanOrEqual(STORAGE_COVER_SIZE.width + 1e-6);
      expect(tile.y + tile.height).toBeLessThanOrEqual(STORAGE_COVER_SIZE.height + 1e-6);
    }
  });
});
