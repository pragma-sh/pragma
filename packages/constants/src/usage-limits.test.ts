import { describe, expect, it } from "vitest";

import {
  formatDuration,
  isStaleReading,
  percentUsed,
  resetsInMs,
  resolvePrimaryLimit,
  usagePercentLabel,
  usageSeverity,
} from "./usage-limits";

const daily = { id: "daily", title: "Daily", used: 25, limit: 100 };

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

describe("resolvePrimaryLimit", () => {
  it("prefers the provider's own summary", () => {
    const summary = { id: "summary", title: "All", used: 1, limit: 2 };
    expect(
      resolvePrimaryLimit("daily", { status: "ready", observedAt: 1, summary, limits: [daily] }),
    ).toBe(summary);
  });

  it("falls back to the named primary category", () => {
    expect(resolvePrimaryLimit("daily", { status: "ready", observedAt: 1, limits: [daily] })).toBe(
      daily,
    );
  });

  it("returns nothing for a reading that is not ready", () => {
    expect(
      resolvePrimaryLimit("daily", {
        status: "unavailable",
        reason: "authentication-required",
        message: "Sign in",
      }),
    ).toBeUndefined();
    expect(resolvePrimaryLimit("daily", undefined)).toBeUndefined();
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

describe("isStaleReading", () => {
  it("labels a reading stale only once it is older than the window", () => {
    expect(isStaleReading({ observedAt: 0 }, 1_000, 500)).toBe(false);
    expect(isStaleReading({ observedAt: 0 }, 1_000, 1_500)).toBe(true);
  });

  it("does not call a provider with no reading stale", () => {
    expect(isStaleReading({}, 1_000, 9_000)).toBe(false);
  });
});
