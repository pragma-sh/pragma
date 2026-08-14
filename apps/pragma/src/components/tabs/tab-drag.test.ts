import { describe, expect, it } from "vitest";

import { dropTargetAt } from "./tab-drag";

const rect = { left: 0, top: 0, width: 100, height: 100 } as DOMRect;

describe("dropTargetAt", () => {
  it("splits toward the nearest quadrant even near the center", () => {
    // No merge zone: a point just left of center splits to the left half.
    const { direction, placement, highlight } = dropTargetAt(rect, 45, 50);
    expect({ direction, placement }).toEqual({ direction: "horizontal", placement: "before" });
    expect(highlight.right).toBe("50%");
  });

  it("splits horizontally to the left from the left quadrant", () => {
    const { direction, placement, highlight } = dropTargetAt(rect, 5, 50);
    expect({ direction, placement }).toEqual({ direction: "horizontal", placement: "before" });
    expect(highlight.right).toBe("50%");
  });

  it("splits horizontally to the right from the right quadrant", () => {
    const { direction, placement, highlight } = dropTargetAt(rect, 95, 50);
    expect({ direction, placement }).toEqual({ direction: "horizontal", placement: "after" });
    expect(highlight.left).toBe("50%");
  });

  it("splits vertically above from the top quadrant", () => {
    const { direction, placement, highlight } = dropTargetAt(rect, 50, 5);
    expect({ direction, placement }).toEqual({ direction: "vertical", placement: "before" });
    expect(highlight.bottom).toBe("50%");
  });

  it("splits vertically below from the bottom quadrant", () => {
    const { direction, placement, highlight } = dropTargetAt(rect, 50, 95);
    expect({ direction, placement }).toEqual({ direction: "vertical", placement: "after" });
    expect(highlight.top).toBe("50%");
  });

  it("still resolves a split for a zero-size rect", () => {
    const empty = { left: 0, top: 0, width: 0, height: 0 } as DOMRect;
    const { direction, placement } = dropTargetAt(empty, 0, 0);
    expect({ direction, placement }).toEqual({ direction: "horizontal", placement: "before" });
  });

  it("clamps positions outside the pane to the nearest edge", () => {
    const { direction, placement } = dropTargetAt(rect, -40, 50);
    expect({ direction, placement }).toEqual({ direction: "horizontal", placement: "before" });
  });
});
