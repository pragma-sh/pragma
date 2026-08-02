import { describe, expect, it } from "vitest";

import { clampScale, fitScale } from "@/components/media/use-media-transform";

describe("fitScale", () => {
  it("scales large media down to fit the pane", () => {
    expect(fitScale(200, 100, 400, 400)).toBeCloseTo(0.25);
  });

  it("does not upscale media smaller than the pane", () => {
    expect(fitScale(800, 600, 100, 50)).toBe(1);
  });

  it("returns 1 when either size is empty", () => {
    expect(fitScale(0, 100, 50, 50)).toBe(1);
    expect(fitScale(100, 100, 0, 50)).toBe(1);
  });
});

describe("clampScale", () => {
  it("clamps into the preview range", () => {
    expect(clampScale(0.001)).toBe(0.05);
    expect(clampScale(100)).toBe(32);
    expect(clampScale(1.5)).toBe(1.5);
  });
});
