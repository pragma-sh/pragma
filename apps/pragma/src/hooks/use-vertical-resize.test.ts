import { describe, expect, it } from "vitest";

import { clampHeight } from "./use-vertical-resize";

describe("clampHeight", () => {
  it("clamps into the range", () => {
    expect(clampHeight(50, 120, 800)).toBe(120);
    expect(clampHeight(400, 120, 800)).toBe(400);
    expect(clampHeight(900, 120, 800)).toBe(800);
  });

  it("lets the minimum win when the maximum is smaller (a tiny diff)", () => {
    expect(clampHeight(400, 120, 60)).toBe(120);
  });
});
