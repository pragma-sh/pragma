import { describe, expect, it } from "vitest";

import {
  agentLaunchArgs,
  resolveAgentOptions,
  type PluginContext,
} from "@pragma-sh/plugin/catalog";

import { claudeCodeAgentPlugin, parseClaudeAgents } from "./pragma-plugin";

/** A context whose host shell finds no command or agent files. */
const emptyHost = {
  project: { id: "p", name: "p", path: "/repo" },
  sdk: { exec: { run: async () => [{ status: 0, stdout: "", stderr: "" }] } },
} as unknown as PluginContext;

const agent = claudeCodeAgentPlugin.agents![0]!;

describe("Claude Code launch options", () => {
  it("exposes built-in slash commands", async () => {
    const { slashCommands } = await resolveAgentOptions(agent, emptyHost);
    expect(slashCommands.map((command) => command.name)).toEqual([
      "init",
      "review",
      "security-review",
    ]);
  });

  it("launches with auto permissions by default and passes other modes through", () => {
    expect(agent.launch.command).toEqual(["claude"]);
    expect(agentLaunchArgs(agent, null)).toEqual(["--permission-mode", "auto"]);
    expect(agentLaunchArgs(agent, { permissionModeId: "plan", modeId: "reviewer" })).toEqual([
      "--agent",
      "reviewer",
      "--permission-mode",
      "plan",
    ]);
  });

  it("lists the agents Claude Code reports, default first and utilities hidden", () => {
    expect(
      parseClaudeAgents(
        "--agent 'x' not found. Available agents: claude, code-reviewer, Explore, general-purpose, Plan, statusline-setup",
      ),
    ).toEqual([
      { id: "claude", name: "Default" },
      { id: "code-reviewer", name: "Code Reviewer" },
      { id: "Explore", name: "Explore" },
      { id: "general-purpose", name: "General Purpose" },
      { id: "Plan", name: "Plan" },
    ]);
    expect(parseClaudeAgents("some other error")).toEqual([]);
  });

  it("falls back to the default agent when the probe fails", async () => {
    const { modes } = await resolveAgentOptions(agent, emptyHost);
    expect(modes).toEqual([{ id: "claude", name: "Default" }]);
    expect(agentLaunchArgs(agent, { modeId: "claude" }, { modes })).toEqual([
      "--permission-mode",
      "auto",
    ]);
  });
});
