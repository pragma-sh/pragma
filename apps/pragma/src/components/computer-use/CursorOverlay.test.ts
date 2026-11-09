import { describe, expect, it } from "vitest";

import { windowClip } from "./CursorOverlay";

describe("windowClip", () => {
  it("clips to the target window in the overlay's coordinates", () => {
    expect(windowClip({ x: 1540, y: 100, w: 200, h: 100 }, { x: 1440, y: 0 })).toBe(
      "polygon(100px 100px, 300px 100px, 300px 200px, 100px 200px)",
    );
  });

  it("does not clip when the window is unknown", () => {
    expect(windowClip(null, { x: 0, y: 0 })).toBeUndefined();
  });
});
