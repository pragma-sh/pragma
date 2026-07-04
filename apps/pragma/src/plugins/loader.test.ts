import { beforeEach, describe, expect, it, vi } from "vitest";
// Namespace import: under `bun --bun vitest` the re-exported `z` binding
// resolves as undefined, while the top-level namespace works everywhere.
import * as z from "zod";

import type { PluginEntryResult } from "@/lib/tauri";
import {
  clearPluginModuleCache,
  invalidatePluginModule,
  loadPluginEntries,
  type PluginLoadContext,
} from "./loader";

const HOST_VERSION = "1.4.0";

function entry(overrides: Partial<PluginEntryResult> = {}): PluginEntryResult {
  return {
    specifier: "../sample-plugin",
    scope: "global",
    projectPath: null,
    config: null,
    manifest: {
      name: "sample-plugin",
      version: "1.0.0",
      dir: "/plugins/sample-plugin",
      mainPath: "/plugins/sample-plugin/index.js",
      modifiedMs: 1000,
    },
    error: null,
    ...overrides,
  };
}

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "sample-plugin", __apiVersion: HOST_VERSION, ...overrides };
}

/** Maps a bundle path to fake source for the order/tagging test. */
const readBundleByName = (mainPath: string): Promise<string> =>
  Promise.resolve(mainPath.includes("global") ? "g" : "p");

/** Builds an importer that resolves to a module namespace with the given default export. */
function importerFor(modules: Record<string, unknown>): (source: string) => Promise<unknown> {
  return (source) => {
    const module = modules[source];
    if (module instanceof Error) {
      return Promise.reject(module);
    }
    return Promise.resolve(module);
  };
}

/** Loads one entry whose bundle default-exports `module`, with shared defaults. */
function loadWith(
  module: unknown,
  entryOverrides: Partial<PluginEntryResult> = {},
  context: Partial<PluginLoadContext> = {},
): ReturnType<typeof loadPluginEntries> {
  return loadPluginEntries([entry(entryOverrides)], {
    hostApiVersion: HOST_VERSION,
    readBundle: () => Promise.resolve("bundle"),
    importModule: importerFor({ bundle: module }),
    ...context,
  });
}

beforeEach(() => {
  clearPluginModuleCache();
});

describe("loadPluginEntries", () => {
  it("loads a valid plugin bundle into a loaded record", async () => {
    const records = await loadWith({ default: definition() });
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("loaded");
    expect(records[0]?.pluginId).toBe("sample-plugin");
    expect(records[0]?.definition?.name).toBe("sample-plugin");
  });

  it("propagates Rust-side resolution errors as failed records with onFailure", async () => {
    const onFailure = vi.fn();
    const records = await loadPluginEntries(
      [entry({ manifest: null, error: "plugin directory not found: /nope" })],
      { hostApiVersion: HOST_VERSION, onFailure },
    );
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.error).toContain("not found");
    expect(records[0]?.pluginId).toBe("../sample-plugin");
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("fails when the bundle has no definePlugin default export", async () => {
    const onFailure = vi.fn();
    const records = await loadWith({ default: { notAPlugin: true } }, {}, { onFailure });
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.error).toContain("definePlugin");
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("fails when the module body throws", async () => {
    const records = await loadWith(new Error("boom at import time"));
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.error).toContain("boom at import time");
  });

  it("refuses a major API version mismatch, naming both versions", async () => {
    const records = await loadWith({ default: definition({ __apiVersion: "2.1.0" }) });
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.error).toContain("built against @pragma/plugin 2.1.0");
    expect(records[0]?.error).toContain("supports 1.x");
  });

  it("loads but warns when the plugin minor is newer than the host", async () => {
    const warn = vi.fn();
    const records = await loadWith(
      { default: definition({ __apiVersion: "1.9.0" }) },
      {},
      { warn },
    );
    expect(records[0]?.status).toBe("loaded");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("validates entry config with the plugin's zod schema", async () => {
    const schema = z.object({ level: z.number() });
    const module = { default: definition({ config: schema }) };
    const ok = await loadWith(module, { config: { level: 3 } });
    expect(ok[0]?.status).toBe("loaded");
    expect(ok[0]?.config).toEqual({ level: 3 });

    clearPluginModuleCache();
    const bad = await loadWith(module, { config: { level: "high" } });
    expect(bad[0]?.status).toBe("failed");
    expect(bad[0]?.error).toContain("invalid plugin config");
    expect(bad[0]?.error).toContain("level");
  });

  it("caches modules per path+version and re-imports after invalidation", async () => {
    const readBundle = vi.fn(() => Promise.resolve("bundle"));
    const context = {
      hostApiVersion: HOST_VERSION,
      readBundle,
      importModule: importerFor({ bundle: { default: definition() } }),
    };
    await loadPluginEntries([entry()], context);
    await loadPluginEntries([entry()], context);
    expect(readBundle).toHaveBeenCalledTimes(1);

    invalidatePluginModule("/plugins/sample-plugin/index.js");
    await loadPluginEntries([entry()], context);
    expect(readBundle).toHaveBeenCalledTimes(2);
  });

  it("preserves declaration order and tags project records with project ids", async () => {
    const importModule = importerFor({
      g: { default: definition({ name: "global-plugin" }) },
      p: { default: definition({ name: "project-plugin" }) },
    });
    const records = await loadPluginEntries(
      [
        entry({
          specifier: "../global-plugin",
          manifest: {
            name: "global-plugin",
            version: "1.0.0",
            dir: "/plugins/global-plugin",
            mainPath: "/plugins/global-plugin/index.js",
            modifiedMs: null,
          },
        }),
        entry({
          specifier: "../project-plugin",
          scope: "project",
          projectPath: "/projects/one",
          manifest: {
            name: "project-plugin",
            version: "1.0.0",
            dir: "/plugins/project-plugin",
            mainPath: "/plugins/project-plugin/index.js",
            modifiedMs: null,
          },
        }),
      ],
      {
        hostApiVersion: HOST_VERSION,
        readBundle: readBundleByName,
        importModule,
        projectIdByPath: (path) => (path === "/projects/one" ? "one" : undefined),
      },
    );
    expect(records.map((record) => record.pluginId)).toEqual(["global-plugin", "project-plugin"]);
    expect(records[1]?.scope).toBe("project");
    expect(records[1]?.projectId).toBe("one");
    expect(records[1]?.projectPath).toBe("/projects/one");
  });
});
