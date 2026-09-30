import { describe, expect, it } from "vitest";

import { resolveAgentOptions, type PluginContext } from "@pragma-sh/plugin/catalog";

import { piAgentPlugin } from "./pragma-plugin";

/** A context whose host shell finds no command or agent files. */
const emptyHost = {
  project: { id: "p", name: "p", path: "/repo" },
  sdk: { exec: { run: async () => [{ status: 0, stdout: "", stderr: "" }] } },
} as unknown as PluginContext;

const agent = piAgentPlugin.agents![0]!;

describe("Pi launch options", () => {
  it("exposes built-in slash commands", async () => {
    const { slashCommands } = await resolveAgentOptions(agent, emptyHost);
    expect(slashCommands.map((command) => command.name)).toEqual(["compact", "session"]);
  });
});
