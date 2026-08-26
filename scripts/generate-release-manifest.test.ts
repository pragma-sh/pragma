import { describe, expect, test } from "bun:test";

import { applyModeForPaths } from "./generate-release-manifest";

describe("applyModeForPaths", () => {
  test("uses reload for desktop React changes", () => {
    expect(applyModeForPaths(["apps/pragma/src/App.tsx"])).toBe("reload");
  });

  test("uses restart when any substantive non-React file changed", () => {
    expect(applyModeForPaths(["apps/pragma/src/App.tsx", "crates/pragma-server/src/main.rs"])).toBe(
      "restart",
    );
  });

  test("uses restart when no substantive paths remain", () => {
    expect(applyModeForPaths([])).toBe("restart");
  });
});
