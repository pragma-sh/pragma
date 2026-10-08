import { describe, expect, it } from "vitest";

import { createLineAccumulator } from "./touch-scroll";

describe("createLineAccumulator", () => {
  it("scrolls back through history when the finger moves down", () => {
    const lines = createLineAccumulator(() => 10);
    expect(lines.push(25)).toBe(-2);
    // The 5px remainder carries into the next movement.
    expect(lines.push(5)).toBe(-1);
  });

  it("scrolls toward the live edge when the finger moves up", () => {
    const lines = createLineAccumulator(() => 10);
    expect(lines.push(-9)).toBe(0);
    expect(lines.push(-1)).toBe(1);
  });

  it("drops the remainder on reset", () => {
    const lines = createLineAccumulator(() => 10);
    lines.push(9);
    lines.reset();
    expect(lines.push(9)).toBe(0);
  });

  it("does nothing before the grid has been measured", () => {
    const lines = createLineAccumulator(() => Number.NaN);
    expect(lines.push(100)).toBe(0);
  });
});
