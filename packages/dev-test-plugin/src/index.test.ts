import { describe, expect, it } from "vitest";

import plugin from "./index";

describe("plugin", () => {
  it("exports a stamped Pragma plugin", () => {
    expect(plugin.__apiVersion).toBeTypeOf("string");
    expect(plugin.name).toBeTypeOf("string");
    expect(plugin.ui?.settingsPages?.[0]?.title).toBe("Dev Test Plugin");
  });
});
