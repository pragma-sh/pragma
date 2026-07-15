import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  browserOpenExternal: vi.fn(async () => {}),
}));

import { browserOpenExternal } from "@/lib/tauri";
import {
  formatDuration,
  openUsageDashboard,
  percentUsed,
  progressColorClass,
} from "./UsageLimitsPopover";

describe("usage limit presentation", () => {
  it("calculates bounded usage from quantities", () => {
    expect(percentUsed({ id: "a", title: "A", used: 25, limit: 100 })).toBe(25);
    expect(percentUsed({ id: "a", title: "A", used: 150, limit: 100 })).toBe(100);
    expect(percentUsed({ id: "a", title: "A", used: 1, limit: null })).toBeNull();
  });

  it("uses blue, yellow, then red severity thresholds", () => {
    expect(progressColorClass(49.9)).toContain("bg-primary");
    expect(progressColorClass(50)).toContain("bg-warning");
    expect(progressColorClass(74.9)).toContain("bg-warning");
    expect(progressColorClass(75)).toContain("bg-destructive");
  });

  it("does not round partial reset days up", () => {
    expect(formatDuration((5 * 24 + 12) * 60 * 60 * 1000)).toBe("5d");
  });

  it("opens provider dashboards in the default browser", () => {
    openUsageDashboard("https://cursor.com/dashboard/spending");
    expect(browserOpenExternal).toHaveBeenCalledWith("https://cursor.com/dashboard/spending");
  });
});
