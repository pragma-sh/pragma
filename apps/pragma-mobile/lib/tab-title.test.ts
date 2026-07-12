import { describe, expect, it } from "vitest";

import { displayTabTitle } from "./tab-title";

describe("displayTabTitle", () => {
  it("uses the terminal fallback until a tab has a name", () => {
    expect(displayTabTitle(null)).toBe("Shell");
    expect(displayTabTitle("  ")).toBe("Shell");
  });

  it("preserves a shell-provided tab name", () => {
    expect(displayTabTitle("Agent: mobile chat")).toBe("Agent: mobile chat");
  });
});
