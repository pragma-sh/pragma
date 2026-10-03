import { describe, expect, it } from "vitest";

import {
  formatDuration,
  percentUsed,
  primaryLimit,
  progressColorClass,
  validateUsageLimitsResult,
} from "./usage-limits";

const limit = { id: "five-hour", title: "5-hour", used: 40, limit: 100 };

describe("usage limit presentation", () => {
  it("calculates bounded usage from quantities", () => {
    expect(percentUsed({ id: "a", title: "A", used: 25, limit: 100 })).toBe(25);
    expect(percentUsed({ id: "a", title: "A", used: 150, limit: 100 })).toBe(100);
    expect(percentUsed({ id: "a", title: "A", used: 1, limit: null })).toBeNull();
  });

  it("uses blue, yellow, then red severity thresholds", () => {
    expect(progressColorClass(49)).toContain("bg-primary");
    expect(progressColorClass(50)).toContain("bg-warning");
    expect(progressColorClass(75)).toContain("bg-destructive");
  });

  it("does not round partial reset days up", () => {
    expect(formatDuration(59 * 60_000)).toBe("59m");
    expect(formatDuration(47 * 60 * 60_000)).toBe("47h");
    expect(formatDuration(71 * 60 * 60_000)).toBe("2d");
  });
});

describe("validateUsageLimitsResult", () => {
  it("accepts a ready result with its primary limit", () => {
    const result = { status: "ready", observedAt: 1, limits: [limit] };
    expect(validateUsageLimitsResult("A", "five-hour", result)).toEqual(result);
  });

  it("turns malformed results into unavailable errors", () => {
    expect(validateUsageLimitsResult("A", "five-hour", null)).toMatchObject({
      status: "unavailable",
    });
    expect(
      validateUsageLimitsResult("A", "five-hour", { status: "ready", observedAt: 1, limits: [] }),
    ).toMatchObject({ message: 'A did not return primary limit "five-hour"' });
    expect(
      validateUsageLimitsResult("A", null, {
        status: "ready",
        observedAt: 1,
        limits: [limit, limit],
      }),
    ).toMatchObject({ message: "A returned an invalid usage limit" });
  });
});

describe("primaryLimit", () => {
  it("prefers the summary, then the declared id", () => {
    const summary = { ...limit, id: "summary" };
    expect(primaryLimit({ status: "ready", observedAt: 1, summary, limits: [limit] }, "x")).toBe(
      summary,
    );
    expect(primaryLimit({ status: "ready", observedAt: 1, limits: [limit] }, "five-hour")).toBe(
      limit,
    );
  });
});
