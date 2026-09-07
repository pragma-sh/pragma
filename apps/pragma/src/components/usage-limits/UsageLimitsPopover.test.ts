import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  browserOpenExternal: vi.fn(async () => {}),
}));

import { browserOpenExternal } from "@/lib/tauri";
import { openUsageDashboard, progressColorClass } from "./UsageLimitsPopover";

describe("usage limit presentation", () => {
  // Bounded percentages, reset countdowns, and the severity thresholds are
  // shared with the mobile client and tested in `@pragma/constants`; what is
  // desktop's own is the mapping onto these classes.
  it("uses blue, yellow, then red severity thresholds", () => {
    expect(progressColorClass(49.9)).toContain("bg-primary");
    expect(progressColorClass(50)).toContain("bg-warning");
    expect(progressColorClass(74.9)).toContain("bg-warning");
    expect(progressColorClass(75)).toContain("bg-destructive");
  });

  it("opens provider dashboards in the default browser", () => {
    openUsageDashboard("https://cursor.com/dashboard/spending");
    expect(browserOpenExternal).toHaveBeenCalledWith("https://cursor.com/dashboard/spending");
  });
});
