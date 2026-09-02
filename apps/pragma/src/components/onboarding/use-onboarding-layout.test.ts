import { describe, expect, it } from "vitest";

import { dialogBox, quantizeHeight, resolveLayout } from "./use-onboarding-layout";

describe("resolveLayout", () => {
  it("sits the clip beside the copy when the panel can hold it unbanded", () => {
    // 1920x1080: a 1408px dialog less the 448px copy column leaves a 960px
    // panel, 540px tall at 16:9 — the tallest the pair may be.
    expect(resolveLayout(1920, 1080)).toMatchObject({ maxHeightPx: 540, orientation: "side" });
  });

  it("stacks once the panel is too narrow to give the copy column its height", () => {
    // 1440x900: the dialog is 1152px, so the panel is 704px — only 396px tall,
    // below the copy column's floor.
    expect(resolveLayout(1440, 900).orientation).toBe("stacked");
  });

  it("stacks in a portrait window, where the panel is bounded by width", () => {
    expect(resolveLayout(1200, 1920).orientation).toBe("stacked");
  });

  it("stacks in a window too short for the panel its width would allow", () => {
    expect(resolveLayout(2560, 560).orientation).toBe("stacked");
  });
});

describe("dialogBox", () => {
  it("takes its width from the height, so the clip's panel is exactly 16:9", () => {
    const layout = resolveLayout(1920, 1080);
    const box = dialogBox(layout, 500);
    expect(box.height).toBe(500);
    // 448px copy column plus a 16:9 panel as tall as the row.
    expect(box.width).toBeCloseTo(448 + 500 * (16 / 9), 5);
  });

  it("clamps a step taller or shorter than the window allows", () => {
    const layout = resolveLayout(1920, 1080);
    expect(dialogBox(layout, 5000).height).toBe(layout.maxHeightPx);
    expect(dialogBox(layout, 100).height).toBe(layout.minHeightPx);
  });

  it("adds the banner to the copy's height when stacked, at a fixed width", () => {
    const layout = resolveLayout(1440, 900);
    const box = dialogBox(layout, 300);
    expect(box.width).toBe(layout.widthPx);
    expect(box.height).toBeCloseTo(layout.widthPx / (16 / 9) + 300, 5);
  });

  it("falls back to the floor before the first measurement", () => {
    const layout = resolveLayout(1920, 1080);
    expect(dialogBox(layout, null).height).toBe(layout.minHeightPx);
  });
});

describe("quantizeHeight", () => {
  it("rounds up to a step size, so a pixel of jitter is not a resize", () => {
    expect(quantizeHeight(497)).toBe(quantizeHeight(499));
    expect(quantizeHeight(497)).toBe(512);
    expect(quantizeHeight(512)).toBe(512);
  });
});
