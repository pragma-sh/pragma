import { describe, expect, it } from "bun:test";

import { officialPluginList, officialPluginLock } from "./index";

describe("official plugin registry", () => {
  it("locks every package exactly once", () => {
    const locked = officialPluginLock.plugins.map((plugin) => plugin.package);
    expect(locked).toEqual(officialPluginList.packages);
    expect(new Set(locked).size).toBe(locked.length);
  });

  it("requires agent binaries for current agent plugins", () => {
    for (const plugin of officialPluginLock.plugins) {
      expect(plugin.manifest.categories).toContain("agent-plugin");
      expect(plugin.manifest.agentBinary).toBeTruthy();
    }
  });
});
