import { describe, expect, it, vi } from "vitest";

import type { PluginDefinition } from "@pragma-sh/plugin";

import type { AgentConfig } from "@/lib/tauri";

import {
  listPluginAgents,
  loadProjectAgent,
  pluginAgentLaunchArgs,
  pluginAgentPrompt,
  resolvePluginAgentModels,
  resolvePluginAgentOptions,
  setPluginAgents,
} from "./agents";
import type { PluginRecord } from "./registry";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => [],
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

/** The active config for `id`; unknown ids stay unknown. */
function agent(id: string): AgentConfig {
  return listPluginAgents().find((candidate) => candidate.id === id) ?? ({ id } as AgentConfig);
}

const projectLoad = vi.hoisted(() => ({ records: [] as unknown[] }));
vi.mock("./loader", () => ({ loadPluginEntries: async () => projectLoad.records }));

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
  it("applies modes, permission modes, and slash-command invocations", async () => {
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
              models: [],
              modes: [
                { id: "build", name: "Build" },
                { id: "plan", name: "Plan" },
              ],
              permissionModes: [{ id: "auto", name: "Auto" }],
              slashCommands: [{ name: "fix" }, { name: "review" }],
              args: {
                model: () => [],
                reasoning: () => [],
                mode: (modeId) => ["--agent", modeId],
                permissionMode: (permissionModeId) => ["--permission", permissionModeId],
                slashCommand: (name) => (name === "fix" ? "/prompts:fix" : `/${name}`),
              },
            },
          ],
          __apiVersion: "1.0.0",
        } as PluginDefinition),
      ],
      { sdk: null, project: null },
    );

    expect(pluginAgentLaunchArgs(agent("plugin-a.agent"), null)).toEqual([
      "--agent",
      "build",
      "--permission",
      "auto",
    ]);
    expect(
      pluginAgentLaunchArgs(agent("plugin-a.agent"), {
        modelId: null,
        reasoningId: null,
        modeId: "plan",
      }),
    ).toEqual(["--agent", "plan", "--permission", "auto"]);
    expect(pluginAgentPrompt(agent("plugin-a.agent"), "fix", "the bug")).toBe(
      "/prompts:fix the bug",
    );
    expect(pluginAgentPrompt(agent("plugin-a.agent"), null, "/review now")).toBe("/review now");
    await expect(resolvePluginAgentOptions("plugin-a.agent")).resolves.toMatchObject({
      slashCommands: [{ name: "fix" }, { name: "review" }],
    });
  });

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
    expect(
      pluginAgentLaunchArgs(agent("plugin-a.agent"), { modelId: "m", reasoningId: "high" }),
    ).toEqual(["--model", "m", "--reasoning", "high"]);
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

  it("builds another project's launch without touching the active agents", async () => {
    const definition = (flag: string) =>
      record({
        name: "Plugin A",
        agents: [
          {
            id: "agent",
            name: "Agent",
            icon: () => null,
            launch: { command: ["agent"] },
            models: [],
            permissionModes: [{ id: "auto", name: "Auto" }],
            args: {
              model: () => [],
              reasoning: () => [],
              permissionMode: () => [flag],
            },
          },
        ],
        __apiVersion: "1.0.0",
      } as PluginDefinition);
    setPluginAgents([definition("--active")], { sdk: null, project: null });
    projectLoad.records = [definition("--watched")];

    const watched = await loadProjectAgent(
      { id: "other", name: "Other", path: "/other" },
      "plugin-a.agent",
    );

    expect(pluginAgentLaunchArgs(watched!, null)).toEqual(["--watched"]);
    expect(pluginAgentLaunchArgs(agent("plugin-a.agent"), null)).toEqual(["--active"]);
  });
});
