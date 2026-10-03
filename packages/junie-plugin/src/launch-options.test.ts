import { describe, expect, it } from "vitest";

import {
  agentLaunchArgs,
  resolveAgentOptions,
  type PluginContext,
} from "@pragma-sh/plugin/catalog";

import { junieAgentPlugin } from "./pragma-plugin";

/** A context whose host shell finds no command or agent files. */
const emptyHost = {
  project: { id: "p", name: "p", path: "/repo" },
  sdk: { exec: { run: async () => [{ status: 0, stdout: "", stderr: "" }] } },
} as unknown as PluginContext;

const agent = junieAgentPlugin.agents![0]!;

describe("Junie launch options", () => {
  it("exposes built-in slash commands", async () => {
    const { slashCommands } = await resolveAgentOptions(agent, emptyHost);
    expect(slashCommands.map((command) => command.name)).toEqual(["review", "plan", "usage"]);
  });

  it("maps plan and brave permission modes to launch flags", () => {
    expect(agentLaunchArgs(agent, { permissionModeId: "plan" })).toEqual(["--plan"]);
    expect(agentLaunchArgs(agent, { permissionModeId: "brave" })).toEqual(["--brave"]);
  });
});
