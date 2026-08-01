import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installLocal } from "../scripts/install-local";

let kimiHome: string;

beforeEach(() => {
  kimiHome = mkdtempSync(join(tmpdir(), "pragma-kimi-install-"));
});

afterEach(() => {
  rmSync(kimiHome, { recursive: true, force: true });
});

describe("installLocal", () => {
  it("copies runtime files and registers the managed plugin", () => {
    const target = installLocal(kimiHome);
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
    installLocal(kimiHome);
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

    installLocal(kimiHome);

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
});
