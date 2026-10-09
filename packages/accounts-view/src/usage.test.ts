import { describe, expect, it } from "vitest";

import {
  formatDuration,
  percentUsed,
  resetsInMs,
  primaryLimit,
  validateUsageLimitsResult,
  usagePercentLabel,
  usageSeverity,
} from "./usage";

const daily = { id: "daily", title: "Daily", used: 25, limit: 100 };
const fiveHour = { id: "five-hour", title: "5-hour", used: 40, limit: 100 };

describe("percentUsed", () => {
  it("reports a bounded percentage", () => {
    expect(percentUsed(daily)).toBe(25);
    expect(percentUsed({ ...daily, used: 500 })).toBe(100);
    expect(percentUsed({ ...daily, used: -5 })).toBe(0);
  });

  it("returns null for an unlimited or nonsensical limit", () => {
    expect(percentUsed({ ...daily, limit: null })).toBeNull();
    expect(percentUsed({ ...daily, limit: 0 })).toBeNull();
  });
});

describe("usagePercentLabel", () => {
  it("names an unlimited category rather than showing 0%", () => {
    expect(usagePercentLabel({ ...daily, limit: null })).toBe("Unlimited");
    expect(usagePercentLabel(daily)).toBe("25% used");
  });
});

describe("usageSeverity", () => {
  it("escalates at the halfway and three-quarter marks", () => {
    expect(usageSeverity(49)).toBe("ok");
    expect(usageSeverity(50)).toBe("warning");
    expect(usageSeverity(74)).toBe("warning");
    expect(usageSeverity(75)).toBe("critical");
  });
});

describe("resetsInMs", () => {
  it("measures the countdown from the observation, not from now", () => {
    expect(resetsInMs({ ...daily, resetsInMs: 60_000 }, 1_000, 31_000)).toBe(30_000);
  });

  it("returns null when the provider reports no reset", () => {
    expect(resetsInMs(daily, 1_000, 1_000)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats minutes, hours, and whole days", () => {
    expect(formatDuration(59 * 60_000)).toBe("59m");
    expect(formatDuration(90 * 60_000)).toBe("2h");
    expect(formatDuration(72 * 60 * 60_000)).toBe("3d");
  });

  it("never reports a negative countdown", () => {
    expect(formatDuration(-5_000)).toBe("0m");
  });
});

describe("validateUsageLimitsResult", () => {
  it("accepts a ready result with its primary limit", () => {
    const result = { status: "ready", observedAt: 1, limits: [fiveHour] };
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
        limits: [fiveHour, fiveHour],
      }),
    ).toMatchObject({ message: "A returned an invalid usage limit" });
  });
});

describe("primaryLimit", () => {
  it("prefers the summary, then the declared id", () => {
    const summary = { ...fiveHour, id: "summary" };
    expect(primaryLimit({ status: "ready", observedAt: 1, summary, limits: [fiveHour] }, "x")).toBe(
      summary,
    );
    expect(primaryLimit({ status: "ready", observedAt: 1, limits: [fiveHour] }, "five-hour")).toBe(
      fiveHour,
    );
  });
});
