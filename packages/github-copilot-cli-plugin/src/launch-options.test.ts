import { describe, expect, it } from "vitest";

import {
  agentLaunchArgs,
  resolveAgentOptions,
  type PluginContext,
} from "@pragma-sh/plugin/catalog";

import { githubCopilotCliPlugin } from "./pragma-plugin";

/** A context whose host shell finds no command or agent files. */
const emptyHost = {
  project: { id: "p", name: "p", path: "/repo" },
  sdk: { exec: { run: async () => [{ status: 0, stdout: "", stderr: "" }] } },
} as unknown as PluginContext;

const agent = githubCopilotCliPlugin.agents![0]!;

describe("GitHub Copilot CLI launch options", () => {
  it("exposes built-in slash commands", async () => {
    const { slashCommands } = await resolveAgentOptions(agent, emptyHost);
    expect(slashCommands.map((command) => command.name)).toEqual(["review", "delegate", "usage"]);
  });

  it("maps custom agents to --agent", () => {
    expect(agentLaunchArgs(agent, { modeId: "docs", permissionModeId: "allow-all" })).toEqual([
      "--agent",
      "docs",
      "--allow-all",
    ]);
  });
});
