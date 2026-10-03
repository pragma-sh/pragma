import { describe, expect, it } from "vitest";

import {
  agentLaunchArgs,
  resolveAgentOptions,
  type PluginContext,
} from "@pragma-sh/plugin/catalog";

import { cursorAgentPlugin } from "./pragma-plugin";

/** A context whose host shell finds no command or agent files. */
const emptyHost = {
  project: { id: "p", name: "p", path: "/repo" },
  sdk: { exec: { run: async () => [{ status: 0, stdout: "", stderr: "" }] } },
} as unknown as PluginContext;

const agent = cursorAgentPlugin.agents![0]!;

describe("Cursor launch options", () => {
  it("exposes built-in slash commands", async () => {
    const { slashCommands } = await resolveAgentOptions(agent, emptyHost);
    expect(slashCommands.map((command) => command.name)).toEqual(["plan", "ask", "debug", "goal"]);
  });

  it("forces commands by default and maps modes to --mode", () => {
    expect(agentLaunchArgs(agent, null)).toEqual(["--force"]);
    expect(agentLaunchArgs(agent, { modeId: "plan", permissionModeId: "default" })).toEqual([
      "--mode",
      "plan",
    ]);
  });
});
