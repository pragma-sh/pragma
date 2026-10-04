import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

const SCRIPT = fileURLToPath(new URL("../scripts/install.mjs", import.meta.url));
const PINNED = `${packageJson.name}@${packageJson.version}`;

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Runs the installer against a temp OpenCode config and returns its `plugin` array. */
function install(existing?: Record<string, unknown>): unknown[] {
  dir = mkdtempSync(join(tmpdir(), "pragma-opencode-install-"));
  const configPath = join(dir, "opencode.json");
  if (existing) writeFileSync(configPath, JSON.stringify(existing));
  execFileSync("node", [SCRIPT], { env: { ...process.env, OPENCODE_CONFIG: configPath } });
  return (JSON.parse(readFileSync(configPath, "utf8")) as { plugin: unknown[] }).plugin;
}

describe("install script", () => {
  it("registers the exact version being installed", () => {
    expect(install()).toEqual([PINNED]);
  });

  it("replaces an unpinned or older entry and keeps other plugins", () => {
    const plugins = install({
      plugin: ["other-plugin", packageJson.name, `${packageJson.name}@0.1.0-alpha.0`],
    });
    expect(plugins).toEqual(["other-plugin", PINNED]);
  });
});
