import { describe, expect, it } from "vitest";

import { averageOpaqueLuminance, needsInvertForLuminance } from "./icon-contrast";

/** Build an RGBA buffer where every pixel shares the same color/alpha. */
function solid(r: number, g: number, b: number, a: number, pixels = 4): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    data.set([r, g, b, a], i * 4);
  }
  return data;
}

/** Average luminance of a solid color, mirroring the real sampling path. */
function luminanceOf(r: number, g: number, b: number): number {
  return averageOpaqueLuminance(solid(r, g, b, 255));
}

describe("averageOpaqueLuminance", () => {
  it("ignores fully transparent pixels when averaging", () => {
    const data = new Uint8ClampedArray(8);
    data.set([255, 255, 255, 255], 0); // one opaque white pixel
    data.set([0, 0, 0, 0], 4); // one transparent black pixel
    expect(averageOpaqueLuminance(data)).toBeCloseTo(1, 5);
  });

  it("treats a fully transparent buffer as light", () => {
    expect(averageOpaqueLuminance(solid(0, 0, 0, 0))).toBe(1);
  });
});

describe("needsInvertForLuminance", () => {
  it("inverts a black (monochrome) icon", () => {
    expect(needsInvertForLuminance(luminanceOf(0, 0, 0))).toBe(true);
  });

  it("inverts a dark gray icon that would vanish on the dark chrome", () => {
    expect(needsInvertForLuminance(luminanceOf(40, 40, 40))).toBe(true);
  });

  it("leaves a white icon untouched", () => {
    expect(needsInvertForLuminance(luminanceOf(255, 255, 255))).toBe(false);
  });

  it("leaves a saturated colored logo (Claude orange) untouched", () => {
    expect(needsInvertForLuminance(luminanceOf(217, 119, 87))).toBe(false);
  });
});
