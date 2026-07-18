import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PluginDefinition } from "@pragma/plugin";
import type { PragmaClient } from "@pragma/sdk";

import type { ResolvedPlugin } from "./catalog";
import { runPluginLifecycles } from "./lifecycle";

function plugin(definition: Partial<PluginDefinition>): ResolvedPlugin {
  return {
    pluginId: "test.plugin",
    scope: "project",
    root: "/project",
    dir: "/plugins/test",
    mainPath: "/plugins/test/plugin.mjs",
    config: { enabled: true },
    definition: { name: "Test", __apiVersion: "1.0.0", ...definition },
  };
}

describe("runPluginLifecycles", () => {
  it("runs install once and load once per server boot", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pragma-plugin-lifecycle-"));
    const onInstall = vi.fn();
    const onPragmaLoad = vi.fn();
    const plugins = [plugin({ onInstall, onPragmaLoad })];
    const sdk = {} as PragmaClient;
    const onError = vi.fn();

    await runPluginLifecycles(plugins, sdk, "/first-root", stateDir, "boot-1", onError);
    await runPluginLifecycles(plugins, sdk, "/first-root", stateDir, "boot-1", onError);
    await runPluginLifecycles(plugins, sdk, "/first-root", stateDir, "boot-2", onError);

    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onPragmaLoad).toHaveBeenCalledTimes(2);
    expect(onInstall.mock.calls[0]?.[0]).toMatchObject({
      pluginId: "test.plugin",
      pluginDir: "/plugins/test",
      config: { enabled: true },
      project: { path: "/project" },
    });
    expect(onError).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(stateDir, "plugin-lifecycle.json"), "utf8"))).toEqual({
      installed: ["test.plugin"],
      loadedByServerBoot: { "test.plugin": "boot-2" },
    });
  });

  it("retries failed hooks without blocking catalog load", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pragma-plugin-lifecycle-"));
    const onInstall = vi.fn().mockRejectedValueOnce(new Error("install failed"));
    const onPragmaLoad = vi.fn().mockRejectedValueOnce(new Error("load failed"));
    const onError = vi.fn();
    const plugins = [plugin({ onInstall, onPragmaLoad })];

    await runPluginLifecycles(plugins, {} as PragmaClient, undefined, stateDir, "boot-1", onError);
    await runPluginLifecycles(plugins, {} as PragmaClient, undefined, stateDir, "boot-1", onError);

    expect(onInstall).toHaveBeenCalledTimes(2);
    expect(onPragmaLoad).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
