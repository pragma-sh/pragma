import { describe, expect, it } from "vitest";

import { progressColorClass, usageToneClass } from "./usage-limits";

describe("usage limit styling", () => {
  it("uses blue, yellow, then red severity thresholds", () => {
    expect(progressColorClass(49)).toContain("bg-primary");
    expect(progressColorClass(50)).toContain("bg-warning");
    expect(progressColorClass(75)).toContain("bg-destructive");
    expect(usageToneClass(74)).toBe("bg-warning");
  });
});
