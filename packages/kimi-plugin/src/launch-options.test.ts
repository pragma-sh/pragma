import { describe, expect, it } from "vitest";

import {
  agentLaunchArgs,
  resolveAgentOptions,
  type PluginContext,
} from "@pragma-sh/plugin/catalog";

import { kimiAgentPlugin, kimiResume } from "./pragma-plugin";

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

  it("wires the resume callback into the launch contract", () => {
    expect(agent.launch.resume).toBe(kimiResume);
  });
});

describe("kimiResume", () => {
  it("builds the full literal argv with model and permission flags", () => {
    expect(
      kimiResume(
        {
          harnessSessionId: "session_02c0b92e-385b-4f56-b67a-08a41a191ee5",
          selection: { modelId: "moonshot/kimi-k3", permissionModeId: "plan", modeId: "okabe" },
          cwd: "/repo",
        },
        emptyHost,
      ),
    ).toEqual([
      "kimi",
      "-m",
      "moonshot/kimi-k3",
      "--plan",
      "--session=session_02c0b92e-385b-4f56-b67a-08a41a191ee5",
    ]);
  });

  it("drops the agent profile, which Kimi refuses with --session", () => {
    const argv = kimiResume(
      { harnessSessionId: "session_x", selection: { modeId: "okabe" }, cwd: "/repo" },
      emptyHost,
    );
    expect(argv).not.toContain("--agent");
  });

  it("applies the default yolo permission when nothing was selected", () => {
    expect(
      kimiResume({ harnessSessionId: "session_x", selection: {}, cwd: "/repo" }, emptyHost),
    ).toEqual(["kimi", "-y", "--session=session_x"]);
  });
});
