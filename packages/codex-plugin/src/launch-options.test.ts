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

  it("resumes the exact session id with the launch flags, never the prompt", async () => {
    const resume = agent.launch.resume;
    expect(resume).toBeTypeOf("function");
    expect(
      await resume!(
        {
          harnessSessionId: "11111111-2222-3333-4444-555555555555",
          selection: { modelId: "gpt-5.6-sol", reasoningId: "high", slashCommand: "review" },
          cwd: "/repo",
        },
        emptyHost,
      ),
    ).toEqual([
      "codex",
      "--no-daemon",
      "resume",
      "11111111-2222-3333-4444-555555555555",
      "--enable",
      "default_mode_request_user_input",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'model_reasoning_effort="high"',
    ]);
  });

  it("replays an explicit permission mode on resume and applies no default", async () => {
    expect(
      await agent.launch.resume!(
        { harnessSessionId: "s", selection: { permissionModeId: "on-request" }, cwd: "/repo" },
        emptyHost,
      ),
    ).toEqual([
      "codex",
      "--no-daemon",
      "resume",
      "s",
      "--enable",
      "default_mode_request_user_input",
      "--ask-for-approval",
      "on-request",
    ]);
    expect(
      await agent.launch.resume!({ harnessSessionId: "s", selection: {}, cwd: "/repo" }, emptyHost),
    ).toEqual([
      "codex",
      "--no-daemon",
      "resume",
      "s",
      "--enable",
      "default_mode_request_user_input",
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
