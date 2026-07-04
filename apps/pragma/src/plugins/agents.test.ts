import { describe, expect, it, vi } from "vitest";

import type { PluginDefinition } from "@pragma/plugin";

import {
  listPluginAgents,
  pluginAgentLaunchArgs,
  resolvePluginAgentModels,
  setPluginAgents,
} from "./agents";
import type { PluginRecord } from "./registry";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

function record(definition: PluginDefinition): PluginRecord {
  return {
    pluginId: "plugin-a",
    version: "1.0.0",
    scope: "global",
    status: "loaded",
    config: undefined,
    definition,
  };
}

describe("plugin agents", () => {
  it("resolves static models and launch args", async () => {
    setPluginAgents(
      [
        record({
          name: "Plugin A",
          agents: [
            {
              id: "agent",
              name: "Agent",
              icon: () => null,
              launch: { command: ["agent"] },
              models: [{ id: "m", name: "Model", reasoning: [{ id: "high", name: "High" }] }],
              permissionModes: [],
              args: {
                model: (modelId) => ["--model", modelId],
                reasoning: (reasoningId) => ["--reasoning", reasoningId],
                permissionMode: (permissionModeId) => ["--permission", permissionModeId],
              },
            },
          ],
          __apiVersion: "1.0.0",
        } as PluginDefinition),
      ],
      { sdk: null, project: null },
    );

    await expect(resolvePluginAgentModels("plugin-a.agent")).resolves.toEqual([
      { id: "m", name: "Model", reasoning: [{ id: "high", name: "High" }] },
    ]);
    expect(pluginAgentLaunchArgs("plugin-a.agent", { modelId: "m", reasoningId: "high" })).toEqual([
      "--model",
      "m",
      "--reasoning",
      "high",
    ]);
  });

  it("resolves plugin-relative icon paths", () => {
    setPluginAgents(
      [
        {
          ...record({
            name: "Plugin A",
            agents: [
              {
                id: "agent",
                name: "Agent",
                icon: () => null,
                iconPath: "assets/icon.svg",
                launch: { command: ["agent"] },
                models: [],
                permissionModes: [],
                args: {
                  model: () => [],
                  reasoning: () => [],
                  permissionMode: () => [],
                },
              },
            ],
            __apiVersion: "1.0.0",
          } as PluginDefinition),
          dir: "/Users/test/.pragma/plugins/plugin-a",
        },
      ],
      { sdk: null, project: null },
    );

    expect(listPluginAgents()[0]?.iconPath).toBe(
      "asset://localhost//Users/test/.pragma/plugins/plugin-a/assets/icon.svg",
    );
  });
});
