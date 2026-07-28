import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveManifests } from "./manifest";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "pragma-root-"));
}

function writePluginDir(root: string, rel: string, name: string, main: string): void {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, main }));
  writeFileSync(join(dir, main), "export default {};\n");
}

function writeConfig(root: string, plugins: Array<{ path: string; config?: unknown }>): void {
  const dir = join(root, ".pragma");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ plugins }));
}

describe("resolveManifests", () => {
  it("resolves a project-scoped local plugin to its main path", async () => {
    const root = makeRoot();
    writePluginDir(root, "my-plugin", "@me/plugin", "index.js");
    writeConfig(root, [{ path: "./my-plugin", config: { a: 1 } }]);

    const manifests = await resolveManifests(makeRoot(), [root]);

    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.pluginId).toBe("@me/plugin");
    expect(manifests[0]?.dir).toBe(join(root, "my-plugin"));
    expect(manifests[0]?.mainPath).toBe(join(root, "my-plugin", "index.js"));
    expect(manifests[0]?.config).toEqual({ a: 1 });
    expect(manifests[0]?.scope).toBe("project");
  });

  it("skips broken entries and missing config files", async () => {
    const root = makeRoot();
    writeConfig(root, [{ path: "./nonexistent" }, { path: "npm-package" }]);

    expect(await resolveManifests(makeRoot(), [root])).toEqual([]);
  });

  it("prefers the package.json pragma field for id and main", async () => {
    const root = makeRoot();
    const dir = join(root, "tool-plugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "@me/tool-plugin",
        main: "./dist/index.mjs",
        pragma: { pluginId: "pragma.tool", main: "./dist/pragma-plugin.mjs" },
      }),
    );
    writeConfig(root, [{ path: "./tool-plugin" }]);

    const manifests = await resolveManifests(makeRoot(), [root]);

    expect(manifests[0]?.pluginId).toBe("pragma.tool");
    expect(manifests[0]?.mainPath).toBe(join(dir, "dist/pragma-plugin.mjs"));
  });

  it("scans a bundled dir ahead of config scopes, without config entries", async () => {
    const bundled = makeRoot();
    writePluginDir(bundled, "b-plugin", "pragma.bundled", "plugin.mjs");
    const root = makeRoot();
    writePluginDir(root, "my-plugin", "@me/plugin", "index.js");
    writeConfig(root, [{ path: "./my-plugin" }]);

    const manifests = await resolveManifests(makeRoot(), [root], bundled);

    expect(manifests.map((m) => [m.pluginId, m.scope])).toEqual([
      ["pragma.bundled", "bundled"],
      ["@me/plugin", "project"],
    ]);
    expect(manifests[0]?.config).toBeUndefined();
  });

  it("uses configured plugins instead of bundled plugins with the same id", async () => {
    const bundled = makeRoot();
    writePluginDir(bundled, "shared-bundled", "pragma.shared", "plugin.mjs");
    const home = makeRoot();
    writePluginDir(home, "shared-global", "pragma.shared", "plugin.mjs");
    writeConfig(home, [{ path: "./shared-global", config: { source: "global" } }]);

    const manifests = await resolveManifests(home, [], bundled);

    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      pluginId: "pragma.shared",
      scope: "global",
      config: { source: "global" },
    });
  });

  it("preserves configured plugin order while resolving manifests concurrently", async () => {
    const root = makeRoot();
    writePluginDir(root, "first", "pragma.first", "plugin.mjs");
    writePluginDir(root, "second", "pragma.second", "plugin.mjs");
    writeConfig(root, [{ path: "./first" }, { path: "./second" }]);

    const manifests = await resolveManifests(makeRoot(), [root]);

    expect(manifests.map((manifest) => manifest.pluginId)).toEqual([
      "pragma.first",
      "pragma.second",
    ]);
  });

  it("treats a missing bundled dir as empty", async () => {
    expect(await resolveManifests(makeRoot(), [], "/does/not/exist")).toEqual([]);
  });
});
