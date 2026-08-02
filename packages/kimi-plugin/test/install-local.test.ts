import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installLocal } from "../scripts/install-local";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Runtime paths that are checked into the package rather than produced by `build`. */
const SOURCE_PATHS = ["assets", "hooks", "kimi.plugin.json", "package.json"];

let kimiHome: string;
let packageRoot: string;

/**
 * Mirrors the package's checked-in runtime files into a temp root and stubs the
 * `dist` bundle, so the test never depends on `bun run build` having run first.
 */
function stagePackageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pragma-kimi-package-"));
  for (const relativePath of SOURCE_PATHS) {
    cpSync(join(PACKAGE_ROOT, relativePath), join(root, relativePath), { recursive: true });
  }
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "pragma-plugin.mjs"), "export default {};\n");
  return root;
}

beforeEach(() => {
  kimiHome = mkdtempSync(join(tmpdir(), "pragma-kimi-install-"));
  packageRoot = stagePackageRoot();
});

afterEach(() => {
  rmSync(kimiHome, { recursive: true, force: true });
  rmSync(packageRoot, { recursive: true, force: true });
});

describe("installLocal", () => {
  it("copies runtime files and registers the managed plugin", () => {
    const target = installLocal(kimiHome, packageRoot);
    const installed = JSON.parse(
      readFileSync(join(kimiHome, "plugins", "installed.json"), "utf8"),
    ) as { plugins: Array<Record<string, unknown>> };

    expect(existsSync(join(target, "kimi.plugin.json"))).toBe(true);
    expect(existsSync(join(target, "hooks", "report.sh"))).toBe(true);
    expect(existsSync(join(target, "dist", "pragma-plugin.mjs"))).toBe(true);
    expect(installed.plugins).toEqual([
      expect.objectContaining({
        id: "pragma-kimi",
        root: target,
        source: "local-path",
        enabled: true,
      }),
    ]);
  });

  it("replaces its snapshot without dropping other plugins or install state", () => {
    const pluginsDir = join(kimiHome, "plugins");
    installLocal(kimiHome, packageRoot);
    const installedPath = join(pluginsDir, "installed.json");
    const installed = JSON.parse(readFileSync(installedPath, "utf8")) as {
      version: 1;
      plugins: Array<Record<string, unknown>>;
    };
    const kimi = installed.plugins[0];
    if (kimi === undefined) throw new Error("Kimi install record missing");
    kimi.enabled = false;
    kimi.installedAt = "2026-01-01T00:00:00.000Z";
    installed.plugins.push({ id: "other-plugin", enabled: true });
    writeFileSync(installedPath, JSON.stringify(installed));

    installLocal(kimiHome, packageRoot);

    const updated = JSON.parse(readFileSync(installedPath, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    expect(updated.plugins).toHaveLength(2);
    expect(updated.plugins.find((plugin) => plugin.id === "pragma-kimi")).toEqual(
      expect.objectContaining({ enabled: false, installedAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(updated.plugins.find((plugin) => plugin.id === "other-plugin")).toEqual({
      id: "other-plugin",
      enabled: true,
    });
  });

  it("refuses to install an unbuilt package", () => {
    rmSync(join(packageRoot, "dist"), { recursive: true, force: true });
    expect(() => installLocal(kimiHome, packageRoot)).toThrow("Missing runtime path: dist");
    expect(existsSync(join(kimiHome, "plugins", "installed.json"))).toBe(false);
  });
});
