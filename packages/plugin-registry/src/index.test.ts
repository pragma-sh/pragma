import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { officialPluginList, officialPluginLock } from "./index";

describe("official plugin registry", () => {
  it("locks official packages exactly once, in official order", () => {
    const locked = officialPluginLock.plugins.map((plugin) => plugin.package);
    // A package awaiting its first npm publish is official but not lockable
    // yet (see AGENTS.md, "Adding an official plugin"), so the lock may be a
    // subset — never a reordering, a duplicate, or a stale entry.
    expect(locked).toEqual(officialPluginList.packages.filter((name) => locked.includes(name)));
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
