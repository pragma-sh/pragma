import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveManifests } from "./manifest";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "pragma-root-"));
}

function writePluginDir(root: string, rel: string, name: string, main: string): string {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, main }));
  const mainPath = join(dir, main);
  mkdirSync(dirname(mainPath), { recursive: true });
  writeFileSync(mainPath, "export default {};\n");
  return dir;
}

function writeConfig(root: string, plugins: Array<{ path: string; config?: unknown }>): void {
  const dir = join(root, ".pragma");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ plugins }));
}

describe("resolveManifests", () => {
  it("resolves a project-scoped local plugin relative to the .pragma directory", async () => {
    const root = makeRoot();
    // `./my-plugin` means `<root>/.pragma/my-plugin`, exactly like plugins.rs.
    writePluginDir(root, ".pragma/my-plugin", "@me/plugin", "index.js");
    writeConfig(root, [{ path: "./my-plugin", config: { a: 1 } }]);

    const manifests = await resolveManifests(makeRoot(), [root]);

    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.pluginId).toBe("@me/plugin");
    expect(manifests[0]?.dir).toBe(join(root, ".pragma/my-plugin"));
    expect(manifests[0]?.mainPath).toBe(join(root, ".pragma/my-plugin", "index.js"));
    expect(manifests[0]?.config).toEqual({ a: 1 });
    expect(manifests[0]?.scope).toBe("project");
    expect(manifests[0]?.root).toBe(root);
  });

  it("resolves ../packages from a project config against the project root (regression)", async () => {
    const root = makeRoot();
    const dir = writePluginDir(root, "packages/alpha", "@me/alpha", "dist/plugin.mjs");
    // The checked-in root config spells portable paths this way.
    writeConfig(root, [{ path: "../packages/alpha" }]);

    const manifests = await resolveManifests(makeRoot(), [root]);

    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      pluginId: "@me/alpha",
      dir,
      mainPath: join(dir, "dist/plugin.mjs"),
      scope: "project",
      // Membership is the project root, never the `.pragma` config directory.
      root,
    });
  });

  it("resolves ../packages from the home config against the home directory", async () => {
    const home = makeRoot();
    const dir = writePluginDir(home, "packages/beta", "pragma.beta", "plugin.mjs");
    writeConfig(home, [{ path: "../packages/beta" }]);

    const manifests = await resolveManifests(home, []);

    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      pluginId: "pragma.beta",
      dir,
      scope: "global",
      root: home,
    });
  });

  it("resolves ~/ against the supplied home directory", async () => {
    const home = makeRoot();
    const dir = writePluginDir(home, "plugins/gamma", "pragma.gamma", "plugin.mjs");
    writeConfig(home, [{ path: "~/plugins/gamma" }]);

    const manifests = await resolveManifests(home, []);

    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.dir).toBe(dir);
  });

  it("resolves an absolute path directly", async () => {
    const root = makeRoot();
    const dir = writePluginDir(root, "abs/plugin", "pragma.absolute", "plugin.mjs");
    writeConfig(root, [{ path: dir }]);

    const manifests = await resolveManifests(makeRoot(), [root]);

    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.dir).toBe(dir);
    expect(manifests[0]?.root).toBe(root);
  });

  it("skips broken entries and npm specifiers", async () => {
    const root = makeRoot();
    writeConfig(root, [
      { path: "./nonexistent" },
      { path: "npm-package" },
      { path: "@scope/plugin" },
      { path: ".hidden" },
    ]);

    expect(await resolveManifests(makeRoot(), [root])).toEqual([]);
  });

  it("prefers the package.json pragma field for id and main", async () => {
    const root = makeRoot();
    const dir = join(root, ".pragma/tool-plugin");
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

  it("uses project plugins instead of global plugins with the same id", async () => {
    const home = makeRoot();
    writePluginDir(home, "shared-global", "pragma.shared", "plugin.mjs");
    writeConfig(home, [{ path: "./shared-global", config: { source: "global" } }]);
    const root = makeRoot();
    const projectDir = writePluginDir(
      root,
      "packages/shared-project",
      "pragma.shared",
      "plugin.mjs",
    );
    writeConfig(root, [{ path: "../packages/shared-project", config: { source: "project" } }]);

    const manifests = await resolveManifests(home, [root]);

    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      pluginId: "pragma.shared",
      dir: projectDir,
      scope: "project",
      root,
      config: { source: "project" },
    });
  });

  it("treats backslash-relative spellings the way the platform's Rust resolver does", async () => {
    const root = makeRoot();
    writePluginDir(root, ".pragma/win", "pragma.win", "plugin.mjs");
    writeConfig(root, [{ path: ".\\win" }]);

    const manifests = await resolveManifests(makeRoot(), [root]);

    // Windows: an explicit relative path (plugins.rs component check).
    // POSIX: `.\win` is one normal component, i.e. an npm specifier.
    expect(manifests).toHaveLength(sep === "\\" ? 1 : 0);
  });

  it("preserves configured plugin order while resolving manifests concurrently", async () => {
    const root = makeRoot();
    writePluginDir(root, ".pragma/first", "pragma.first", "plugin.mjs");
    writePluginDir(root, ".pragma/second", "pragma.second", "plugin.mjs");
    writeConfig(root, [{ path: "./first" }, { path: "./second" }]);

    const manifests = await resolveManifests(makeRoot(), [root]);

    expect(manifests.map((manifest) => manifest.pluginId)).toEqual([
      "pragma.first",
      "pragma.second",
    ]);
  });
});
