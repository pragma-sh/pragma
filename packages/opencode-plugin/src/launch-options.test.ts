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
});
