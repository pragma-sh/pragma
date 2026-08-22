import { describe, expect, it } from "bun:test";

import { officialPluginLock } from "@pragma/plugin-registry";

import { pluginInstallUrl } from "./plugins";

describe("plugin gallery data", () => {
  it("locks unique package names with complete manifests", () => {
    const packages = officialPluginLock.plugins.map((plugin) => plugin.package);
    expect(new Set(packages).size).toBe(packages.length);
    for (const plugin of officialPluginLock.plugins) {
      expect(plugin.manifest.name.length).toBeGreaterThan(0);
      expect(plugin.manifest.description.length).toBeGreaterThan(0);
      expect(plugin.integrity).toStartWith("sha512-");
    }
  });

  it("encodes scoped package names in install links", () => {
    expect(pluginInstallUrl("@pragma-sh/opencode-plugin")).toBe(
      "pragma://install-plugin?package=%40pragma-sh%2Fopencode-plugin",
    );
  });
});
