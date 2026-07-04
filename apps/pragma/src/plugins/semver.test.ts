import { describe, expect, it } from "vitest";

import { checkPluginCompatibility, parseSemver } from "./semver";

describe("parseSemver", () => {
  it("parses plain versions", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("ignores pre-release and build suffixes", () => {
    expect(parseSemver("2.0.1-beta.1+build5")).toEqual({ major: 2, minor: 0, patch: 1 });
  });

  it("rejects malformed versions", () => {
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("not-a-version")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("checkPluginCompatibility", () => {
  it("accepts an exact match", () => {
    expect(checkPluginCompatibility("1.4.0", "1.4.0")).toEqual({ kind: "ok" });
  });

  it("accepts a plugin built against an older minor", () => {
    expect(checkPluginCompatibility("1.2.9", "1.4.0")).toEqual({ kind: "ok" });
  });

  it("warns when the plugin minor is newer than the host", () => {
    const result = checkPluginCompatibility("1.6.0", "1.4.0");
    expect(result.kind).toBe("warn");
    if (result.kind === "warn") {
      expect(result.message).toContain("1.6.0");
      expect(result.message).toContain("1.4.0");
    }
  });

  it("refuses a major mismatch, naming both versions", () => {
    const result = checkPluginCompatibility("2.1.0", "1.4.0");
    expect(result.kind).toBe("refuse");
    if (result.kind === "refuse") {
      expect(result.message).toContain("built against @pragma/plugin 2.1.0");
      expect(result.message).toContain("supports 1.x");
    }
  });

  it("refuses an older major too", () => {
    expect(checkPluginCompatibility("0.9.0", "1.4.0").kind).toBe("refuse");
  });

  it("refuses invalid plugin versions", () => {
    expect(checkPluginCompatibility("garbage", "1.4.0").kind).toBe("refuse");
  });
});
