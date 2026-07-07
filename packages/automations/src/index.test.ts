import { describe, expect, it } from "vitest";

import { defineAutomation } from "./index.ts";

describe("defineAutomation", () => {
  it("marks a definition for sidecar validation", () => {
    const automation = defineAutomation({
      name: "Test automation",
      description: "Runs in tests",
      trigger: { type: "cron", schedule: "* * * * *" },
      run() {},
    });

    expect(automation.pragmaAutomation).toBe(true);
    expect(automation.name).toBe("Test automation");
  });
});
