import { describe, expect, it } from "bun:test";
import { join } from "node:path";

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

  it("ships detail-page copy in every workspace manifest", async () => {
    for (const packageName of officialPluginList.packages) {
      const source = join(import.meta.dir, "..", "..", packageName.split("/").at(-1) ?? "");
      const manifest = (await Bun.file(join(source, "pragma-plugin.json")).json()) as {
        longDescription?: string;
      };
      expect(
        manifest.longDescription?.length ?? 0,
        `${packageName}: missing longDescription`,
      ).toBeGreaterThan(0);
    }
  });
});
