import { describe, expect, it } from "vitest";

import { opencodeAgentPlugin, parseOpenCodeAgents } from "./pragma-plugin";

const agent = opencodeAgentPlugin.agents![0]!;

describe("OpenCode launch options", () => {
  it("lists visible primary agents with build and plan first", () => {
    const output = [
      "orchestrator (primary)",
      '  [{ "permission": "*" }]',
      "plan (primary)",
      "build (primary)",
      "explore (subagent)",
      "title (primary)",
      "docs (all)",
    ].join("\n");
    expect(parseOpenCodeAgents(output).map((mode) => mode.id)).toEqual([
      "build",
      "plan",
      "orchestrator",
      "docs",
    ]);
  });

  it("falls back to build and plan", () => {
    expect(parseOpenCodeAgents("").map((mode) => mode.id)).toEqual(["build", "plan"]);
  });

  it("selects the agent with --agent", () => {
    expect(agent.args.mode?.("plan")).toEqual(["--agent", "plan"]);
  });

  it("resumes the exact session id with the selection's model and agent", async () => {
    const resume = agent.launch.resume;
    expect(resume).toBeTypeOf("function");
    expect(
      await resume!(
        {
          harnessSessionId: "ses_01ABC",
          selection: { modelId: "anthropic/claude-sonnet-5-5", modeId: "plan" },
          cwd: "/repo",
        },
        undefined as never,
      ),
    ).toEqual([
      "opencode",
      "--session",
      "ses_01ABC",
      "--model",
      "anthropic/claude-sonnet-5-5",
      "--agent",
      "plan",
    ]);
  });

  it("resumes without inventing a selection and never replays a prompt", async () => {
    expect(
      await agent.launch.resume!(
        {
          harnessSessionId: "ses_01ABC",
          selection: { slashCommand: "review" },
          cwd: "/repo",
        },
        undefined as never,
      ),
    ).toEqual(["opencode", "--session", "ses_01ABC"]);
  });
});
