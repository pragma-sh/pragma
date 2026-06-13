import { describe, expect, it } from "vitest";

import { rectToBounds, screenshotBounds } from "./browser-manager";

/** Minimal DOMRect for the geometry helpers (they only read these four fields). */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height } as DOMRect;
}

describe("rectToBounds", () => {
  it("maps a DOM rect to logical window bounds", () => {
    expect(rectToBounds(rect(10, 20, 800, 600))).toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
    });
  });
});

describe("screenshotBounds", () => {
  it("offsets by screen position and scales by device pixel ratio", () => {
    expect(screenshotBounds(rect(10, 20, 800, 600), 100, 50, 2)).toEqual({
      x: (10 + 100) * 2,
      y: (20 + 50) * 2,
      width: 1600,
      height: 1200,
    });
  });

  it("is identity at dpr 1 with no screen offset", () => {
    expect(screenshotBounds(rect(5, 6, 7, 8), 0, 0, 1)).toEqual({
      x: 5,
      y: 6,
      width: 7,
      height: 8,
    });
  });
});
