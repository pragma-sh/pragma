import { describe, expect, test } from "bun:test";

import { newestInstallableDesktopRelease, type ReleaseSummary } from "./pin-latest-desktop-release";

function release(tag: string, assets: string[] = ["release.json"], extra = {}): ReleaseSummary {
  return { tag_name: tag, draft: false, prerelease: false, assets, ...extra };
}

describe("newestInstallableDesktopRelease", () => {
  test("ignores component releases that GitHub would otherwise mark Latest", () => {
    const releases = [
      release("dev-test-plugin-v0.1.3"),
      release("opencode-plugin-v0.2.3-alpha.0"),
      release("pragma-v0.4.0"),
    ];
    expect(newestInstallableDesktopRelease(releases, "release.json")).toBe("pragma-v0.4.0");
  });

  test("skips a desktop tag whose publish never uploaded the manifest", () => {
    const releases = [release("pragma-v0.4.0"), release("pragma-v0.5.0", [])];
    expect(newestInstallableDesktopRelease(releases, "release.json")).toBe("pragma-v0.4.0");
  });

  test("orders by version, not by listing order", () => {
    const releases = [release("pragma-v0.9.0"), release("pragma-v0.10.0")];
    expect(newestInstallableDesktopRelease(releases, "release.json")).toBe("pragma-v0.10.0");
  });

  test("skips drafts and prereleases", () => {
    const releases = [
      release("pragma-v0.4.0"),
      release("pragma-v0.5.0", undefined, { draft: true }),
      release("pragma-v0.6.0", undefined, { prerelease: true }),
    ];
    expect(newestInstallableDesktopRelease(releases, "release.json")).toBe("pragma-v0.4.0");
  });

  test("returns null before any desktop release is installable", () => {
    const releases = [release("pragma-v0.2.0", []), release("dev-test-plugin-v0.1.3")];
    expect(newestInstallableDesktopRelease(releases, "release.json")).toBeNull();
  });
});
