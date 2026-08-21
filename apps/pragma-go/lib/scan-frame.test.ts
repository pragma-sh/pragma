import { describe, expect, it } from "vitest";

import { sameScanFrame, scanFrame, type ScanFrame } from "./scan-frame";

const view = { width: 300, height: 300 };

describe("scanFrame", () => {
  it("boxes the corner points with padding", () => {
    const frame = scanFrame(
      {
        cornerPoints: [
          { x: 100, y: 110 },
          { x: 160, y: 110 },
          { x: 160, y: 170 },
          { x: 100, y: 170 },
        ],
      },
      view,
    );

    expect(frame).toEqual({ x: 90, y: 100, width: 80, height: 80 });
  });

  it("falls back to bounds when corner points are missing", () => {
    const frame = scanFrame(
      { cornerPoints: [], bounds: { origin: { x: 50, y: 60 }, size: { width: 40, height: 40 } } },
      view,
    );

    expect(frame).toEqual({ x: 40, y: 50, width: 60, height: 60 });
  });

  it("clamps a code that reaches the edge of the preview", () => {
    const frame = scanFrame(
      { bounds: { origin: { x: 0, y: 0 }, size: { width: 300, height: 300 } } },
      view,
    );

    expect(frame).toEqual({ x: 0, y: 0, width: 300, height: 300 });
  });

  it("rejects a detection that lies outside the view", () => {
    const frame = scanFrame(
      { bounds: { origin: { x: 400, y: 400 }, size: { width: 40, height: 40 } } },
      view,
    );

    expect(frame).toBeNull();
  });

  it("rejects an unmeasured view and a degenerate report", () => {
    expect(scanFrame({ cornerPoints: [{ x: 1, y: 1 }] }, { width: 0, height: 0 })).toBeNull();
    expect(scanFrame({ cornerPoints: [] }, view)).toBeNull();
    expect(
      scanFrame({ bounds: { origin: { x: 10, y: 10 }, size: { width: 0, height: 0 } } }, view),
    ).toBeNull();
    expect(scanFrame({ cornerPoints: [{ x: Number.NaN, y: 1 }] }, view)).toBeNull();
  });
});

describe("sameScanFrame", () => {
  const frame: ScanFrame = { x: 10, y: 10, width: 50, height: 50 };

  it("treats a jitter-sized move as the same frame", () => {
    expect(sameScanFrame(frame, { ...frame, x: 12 })).toBe(true);
  });

  it("treats a real move as a new frame", () => {
    expect(sameScanFrame(frame, { ...frame, x: 40 })).toBe(false);
  });

  it("compares absence exactly", () => {
    expect(sameScanFrame(null, null)).toBe(true);
    expect(sameScanFrame(null, frame)).toBe(false);
  });
});
