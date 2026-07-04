import { afterEach, describe, expect, it } from "vitest";

import type { PluginDefinition } from "@pragma/plugin";

import {
  clearPlugins,
  collectContributions,
  getActivePlugins,
  getAllPlugins,
  replacePlugin,
  setPluginsForScope,
  type PluginRecord,
} from "./registry";

function record(overrides: Partial<PluginRecord> & { pluginId: string }): PluginRecord {
  return {
    version: "1.0.0",
    scope: "global",
    status: "loaded",
    config: undefined,
    ...overrides,
  };
}

afterEach(() => {
  clearPlugins();
});

describe("plugin registry", () => {
  it("orders records builtin, then global, then project", () => {
    setPluginsForScope("project", "/p/one", [
      record({ pluginId: "project-plugin", scope: "project", projectId: "one" }),
    ]);
    setPluginsForScope("global", null, [record({ pluginId: "global-plugin" })]);
    setPluginsForScope("builtin", null, [record({ pluginId: "builtin-plugin", scope: "builtin" })]);

    expect(getAllPlugins().map((r) => r.pluginId)).toEqual([
      "builtin-plugin",
      "global-plugin",
      "project-plugin",
    ]);
  });

  it("filters project records by the active project, keeping others cached", () => {
    setPluginsForScope("global", null, [record({ pluginId: "global-plugin" })]);
    setPluginsForScope("project", "/p/one", [
      record({ pluginId: "one-plugin", scope: "project", projectId: "one", projectPath: "/p/one" }),
    ]);
    setPluginsForScope("project", "/p/two", [
      record({ pluginId: "two-plugin", scope: "project", projectId: "two", projectPath: "/p/two" }),
    ]);

    expect(getActivePlugins("one").map((r) => r.pluginId)).toEqual(["global-plugin", "one-plugin"]);
    expect(getActivePlugins("two").map((r) => r.pluginId)).toEqual(["global-plugin", "two-plugin"]);
    // No active project: only non-project scopes are visible.
    expect(getActivePlugins(null).map((r) => r.pluginId)).toEqual(["global-plugin"]);
    // Both projects' records stay cached in the registry.
    expect(getAllPlugins()).toHaveLength(3);
  });

  it("replaces one scope's records without touching other scopes", () => {
    setPluginsForScope("global", null, [record({ pluginId: "a" }), record({ pluginId: "b" })]);
    setPluginsForScope("project", "/p/one", [
      record({ pluginId: "c", scope: "project", projectId: "one", projectPath: "/p/one" }),
    ]);
    setPluginsForScope("global", null, [record({ pluginId: "b" })]);

    expect(getAllPlugins().map((r) => r.pluginId)).toEqual(["b", "c"]);
  });

  it("replacePlugin swaps a single record in place (hot reload)", () => {
    setPluginsForScope("global", null, [
      record({ pluginId: "a", version: "1.0.0" }),
      record({ pluginId: "b" }),
    ]);
    replacePlugin(record({ pluginId: "a", version: "1.0.1" }));

    const versions = getAllPlugins().map((r) => `${r.pluginId}@${r.version}`);
    expect(versions).toEqual(["a@1.0.1", "b@1.0.0"]);
  });

  it("collects contributions only from loaded plugins, tagged with their origin", () => {
    const command = { id: "x.run", title: "Run", run: () => {} };
    const definition = {
      name: "x",
      commands: [command],
      __apiVersion: "1.0.0",
    } as unknown as PluginDefinition;
    setPluginsForScope("global", null, [
      record({ pluginId: "x", definition }),
      record({ pluginId: "broken", status: "failed", error: "boom" }),
    ]);
    setPluginsForScope("project", "/p/one", [
      record({
        pluginId: "y",
        scope: "project",
        projectId: "one",
        projectPath: "/p/one",
        definition: { ...definition, name: "y" } as PluginDefinition,
      }),
    ]);

    const tagged = collectContributions(getActivePlugins("one"), (def) => def.commands);
    expect(tagged).toEqual([
      { pluginId: "x", scope: "global", contribution: command },
      { pluginId: "y", scope: "project", projectId: "one", contribution: command },
    ]);
  });
});
