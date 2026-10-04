import { describe, expect, test } from "bun:test";

import { applyModeForPaths, assetKey, requiredAssetKeys } from "./generate-release-manifest";

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

describe("Windows ARM64 release assets", () => {
  test("recognises the normalized installer name", () => {
    expect(assetKey("Pragma-1.1.0-windows-aarch64.exe")).toBe("windows-aarch64");
  });

  test("requires the installer on native releases", () => {
    expect(requiredAssetKeys("restart")).toContain("windows-aarch64");
  });
});
