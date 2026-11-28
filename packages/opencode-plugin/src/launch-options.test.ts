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

/** A v2 host whose `opencode api` answers each path from `responses`. */
function v2Host(responses: Record<string, unknown>): never {
  return {
    project: { path: "/repo" },
    sdk: {
      exec: {
        run: async ({ commands }: { commands: string[] }) =>
          commands.map((command) => {
            const path = Object.keys(responses).find((key) => command.includes(`'${key}'`));
            return {
              command,
              stdout: command.includes("--version")
                ? "opencode v2.1.1\n"
                : path
                  ? JSON.stringify(responses[path])
                  : "",
              stderr: "",
              status: command.includes("--version") || path ? 0 : 1,
              durationMs: 0,
            };
          }),
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
    it("lists OpenCode's models, variants, and agents from its server API", async () => {
      const ctx = v2Host({
        "/api/model": {
          data: [
            {
              id: "gpt-5.6-sol",
              providerID: "openai",
              name: "GPT-5.6 Sol",
              enabled: true,
              variants: [{ id: "low" }, { id: "high" }],
            },
            { id: "glm-5.3", providerID: "opencode-go", name: "GLM-5.3", variants: [] },
            { id: "off", providerID: "openai", name: "Off", enabled: false },
          ],
        },
        "/api/agent": {
          data: [
            { id: "orchestrator", name: "orchestrator", mode: "primary", hidden: false },
            { id: "plan", name: "Plan", mode: "primary", hidden: false },
            { id: "explore", name: "Explore", mode: "subagent", hidden: false },
            { id: "title", name: "Title", mode: "primary", hidden: true },
            { id: "build", name: "Build", mode: "primary", hidden: false },
          ],
        },
      });
      expect(await (agent.models as (ctx: never) => Promise<unknown[]>)(ctx)).toEqual([
        {
          id: "openai/gpt-5.6-sol",
          name: "GPT-5.6 Sol (openai)",
          reasoning: [
            { id: "low", name: "Low" },
            { id: "high", name: "High" },
          ],
        },
        { id: "opencode-go/glm-5.3", name: "GLM-5.3 (opencode-go)" },
      ]);
      expect(await (agent.modes as (ctx: never) => Promise<unknown[]>)(ctx)).toEqual([
        { id: "build", name: "Build" },
        { id: "plan", name: "Plan" },
        { id: "orchestrator", name: "Orchestrator" },
      ]);
    });

    it("still lists a model and the built-in agents when the API cannot be read", async () => {
      const ctx = v2Host({});
      const models = await (agent.models as (ctx: never) => Promise<{ id: string }[]>)(ctx);
      expect(models.map((model) => model.id)).toEqual(["default"]);
      const modes = await (agent.modes as (ctx: never) => Promise<{ id: string }[]>)(ctx);
      expect(modes.map((mode) => mode.id)).toEqual(["build", "plan"]);
    });

    it("passes neither flag: the watcher applies the selection in the TUI", async () => {
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
