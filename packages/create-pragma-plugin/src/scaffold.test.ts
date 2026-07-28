import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizePluginName, scaffoldPlugin } from "./index";
import { detectPackageManager } from "./package-manager";

describe("create-pragma-plugin", () => {
  it("normalizes package names", () => {
    expect(normalizePluginName("My Plugin!")).toBe("my-plugin");
    expect(normalizePluginName("@scope/name")).toBe("scope-name");
  });

  it("detects package managers from nearest lockfile", async () => {
    const root = await tempDir();
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    await mkdir(join(root, "nested"));

    expect(detectPackageManager(join(root, "nested"))).toBe("pnpm");
  });

  it("scaffolds a loadable single-bundle plugin template", async () => {
    const root = await tempDir();
    const result = await scaffoldPlugin({
      directory: join(root, "my-plugin"),
      packageManager: "bun",
      capabilities: ["ui", "commands"],
    });

    expect(result.files).toContain("package.json");
    const packageJson = JSON.parse(await readFile(join(result.directory, "package.json"), "utf8"));
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.scripts.dev).toBe("vite build --watch");
    await expect(readFile(join(result.directory, "vite.config.ts"), "utf8")).resolves.toContain(
      '"react/jsx-runtime": "@pragma/plugin/jsx-runtime"',
    );
    await expect(readFile(join(result.directory, "README.md"), "utf8")).resolves.toContain(
      '{ "path": "./my-plugin" }',
    );
  });

  it("refuses to overwrite non-empty directories unless forced", async () => {
    const root = await tempDir();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "existing.txt"), "x");

    await expect(scaffoldPlugin({ directory: root })).rejects.toThrow("destination is not empty");
    await expect(scaffoldPlugin({ directory: root, force: true })).resolves.toMatchObject({
      directory: root,
    });
  });
});

async function tempDir(): Promise<string> {
  // `os.tmpdir()`, never a literal "/tmp": that path does not exist on Windows and
  // `mkdtemp` fails with ENOENT there.
  return await mkdtemp(join(tmpdir(), "pragma-plugin-"));
}
