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
    expect(manifests[0]?.mainPath).toBe(join(root, "my-plugin", "index.js"));
    expect(manifests[0]?.config).toEqual({ a: 1 });
    expect(manifests[0]?.scope).toBe("project");
  });

  it("skips broken entries and missing config files", async () => {
    const root = makeRoot();
    writeConfig(root, [{ path: "./nonexistent" }, { path: "npm-package" }]);

    expect(await resolveManifests(makeRoot(), [root])).toEqual([]);
  });
});
