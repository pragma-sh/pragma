import { describe, expect, it } from "vitest";

import {
  agentLaunchArgs,
  resolveAgentOptions,
  type PluginContext,
} from "@pragma-sh/plugin/catalog";

import { kimiAgentPlugin } from "./pragma-plugin";

/** A context whose host shell finds no command or agent files. */
const emptyHost = {
  project: { id: "p", name: "p", path: "/repo" },
  sdk: { exec: { run: async () => [{ status: 0, stdout: "", stderr: "" }] } },
} as unknown as PluginContext;

const agent = kimiAgentPlugin.agents![0]!;

describe("Kimi launch options", () => {
  it("exposes built-in slash commands", async () => {
    const { slashCommands } = await resolveAgentOptions(agent, emptyHost);
    expect(slashCommands.map((command) => command.name)).toEqual(["init", "compact"]);
  });

  it("launches in yolo mode by default", () => {
    expect(agent.launch.command).toEqual(["kimi"]);
    expect(agentLaunchArgs(agent, null)).toEqual(["-y"]);
    expect(agentLaunchArgs(agent, { modeId: "okabe", permissionModeId: "plan" })).toEqual([
      "--agent",
      "okabe",
      "--plan",
    ]);
  });
});
