import { describe, expect, it } from "vitest";

import {
  agentLaunchArgs,
  resolveAgentOptions,
  type PluginContext,
} from "@pragma-sh/plugin/catalog";

import { codexAgentPlugin, parseCodexSkills } from "./pragma-plugin";

/** A context whose host shell finds no command or agent files. */
const emptyHost = {
  project: { id: "p", name: "p", path: "/repo" },
  sdk: { exec: { run: async () => [{ status: 0, stdout: "", stderr: "" }] } },
} as unknown as PluginContext;

const agent = codexAgentPlugin.agents![0]!;

describe("Codex launch options", () => {
  it("exposes built-in slash commands", async () => {
    const { slashCommands } = await resolveAgentOptions(agent, emptyHost);
    expect(slashCommands.map((command) => command.name)).toEqual([
      "init",
      "review",
      "status",
      "diff",
    ]);
  });

  it("leaves approvals to Codex config by default", () => {
    expect(agentLaunchArgs(agent, null)).toEqual([]);
    expect(agentLaunchArgs(agent, { permissionModeId: "never" })).toEqual([
      "--ask-for-approval",
      "never",
    ]);
  });

  it("reads the skills Codex resolved and invokes them with $", () => {
    const prompt = [
      {
        type: "message",
        content: [
          {
            type: "input_text",
            text: "## Skills\n### Available skills\n- imagegen: Make images (file: r2/imagegen/SKILL.md)\n- plugin:review: Review it\n### How to use skills\n- not-a-skill: ignored",
          },
        ],
      },
    ];
    expect(parseCodexSkills(JSON.stringify(prompt))).toEqual([
      { name: "imagegen", description: "Make images", invocation: "$imagegen" },
      { name: "plugin:review", description: "Review it", invocation: "$plugin:review" },
    ]);
    expect(parseCodexSkills("not json and no skills")).toEqual([]);
  });
});
