import { afterEach, describe, expect, it } from "bun:test";

import { officialPluginLock } from "@pragma/plugin-registry";

import { loadOfficialPlugins, pluginInstallUrl } from "./plugins";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("plugin gallery data", () => {
  it("locks unique package names with complete manifests", () => {
    const packages = officialPluginLock.plugins.map((plugin) => plugin.package);
    expect(new Set(packages).size).toBe(packages.length);
    for (const plugin of officialPluginLock.plugins) {
      expect(plugin.manifest.name.length).toBeGreaterThan(0);
      expect(plugin.manifest.description.length).toBeGreaterThan(0);
      expect(plugin.manifest.install.command.length).toBeGreaterThan(0);
      expect(plugin.integrity).toStartWith("sha512-");
    }
  });

  it("encodes scoped package names in install links", () => {
    expect(pluginInstallUrl("@pragma-sh/opencode-plugin")).toBe(
      "pragma://install-plugin?package=%40pragma-sh%2Fopencode-plugin",
    );
  });

  it("falls back to the checked-in lock when the remote lock is unavailable", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;

    expect(await loadOfficialPlugins()).toEqual(officialPluginLock.plugins);
  });
});
