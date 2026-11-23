import { beforeEach, describe, expect, it } from "vitest";

import { resetOpenCodeVersionCache } from "./opencode-version";
import { opencodeAgentPlugin, parseOpenCodeAgents } from "./pragma-plugin";

const agent = opencodeAgentPlugin.agents![0]!;

/** A plugin context whose host answers every command as that OpenCode version would. */
function hostRunning(version: string, stdout = ""): never {
  return {
    project: { path: "/repo" },
    sdk: {
      exec: {
        run: async ({ commands }: { commands: string[] }) =>
          commands.map((command) => ({
            command,
            stdout: command.includes("--version") ? `${version}\n` : stdout,
            stderr: "",
            status: 0,
            durationMs: 0,
          })),
      },
    },
  } as never;
}

beforeEach(() => resetOpenCodeVersionCache());

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
        hostRunning("1.19.3"),
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
        hostRunning("1.19.3"),
      ),
    ).toEqual(["opencode", "--session", "ses_01ABC"]);
  });

  // OpenCode v2 dropped both flags from its TUI command: `opencode --model x`
  // prints "Unrecognized flag: --model in command opencode" and exits.
  describe("on OpenCode v2", () => {
    it("offers only OpenCode's own model and no modes, since a launch cannot select one", async () => {
      const ctx = hostRunning("opencode v2.1.1", "opencode-go/glm-5\nplan (primary)\n");
      const models = await (agent.models as (ctx: never) => Promise<{ id: string }[]>)(ctx);
      expect(models.map((model) => model.id)).toEqual(["default"]);
      expect(agent.args.model("default")).toEqual([]);
      expect(await (agent.modes as (ctx: never) => Promise<unknown[]>)(ctx)).toEqual([]);
    });

    it("passes neither flag, even for a selection saved under v1", async () => {
      const ctx = hostRunning("opencode v2.1.1");
      await (agent.models as (ctx: never) => Promise<unknown[]>)(ctx);
      expect(agent.args.model("opencode-go/glm-5")).toEqual([]);
      expect(agent.args.mode?.("plan")).toEqual([]);
    });

    it("resumes by session id alone", async () => {
      expect(
        await agent.launch.resume!(
          {
            harnessSessionId: "ses_01ABC",
            selection: { modelId: "opencode-go/glm-5", modeId: "plan" },
            cwd: "/repo",
          },
          hostRunning("opencode v2.1.1"),
        ),
      ).toEqual(["opencode", "--session", "ses_01ABC"]);
    });

    it("keeps the flags when the version probe fails", async () => {
      const failing = {
        project: { path: "/repo" },
        sdk: {
          exec: {
            run: async () => [{ command: "", stdout: "", stderr: "", status: 127, durationMs: 0 }],
          },
        },
      } as never;
      await agent.launch.resume!({ harnessSessionId: "s", selection: {}, cwd: "/repo" }, failing);
      expect(agent.args.model("x/y")).toEqual(["--model", "x/y"]);
    });
  });
});
