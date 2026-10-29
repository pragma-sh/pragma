import type {
  AgentDefinition,
  AgentResumeRequest,
  PluginContext,
  PluginDefinition,
} from "@pragma-sh/plugin";
import type { PragmaClient } from "@pragma-sh/sdk";
import { describe, expect, it } from "vitest";

import type { ResolvedPlugin } from "./catalog";
import { resolveAgentResume, validateResumeArgv } from "./resume";

function plugin(
  definition: Omit<PluginDefinition, "__apiVersion" | "name">,
  overrides: Partial<ResolvedPlugin> = {},
): ResolvedPlugin {
  return {
    pluginId: "pragma.demo",
    scope: "global",
    root: "/plugins",
    dir: "/plugins/demo",
    mainPath: "/plugins/demo/dist/main.mjs",
    config: { flavor: "demo" },
    definition: { name: "Demo", ...definition, __apiVersion: "0.0.0" },
    ...overrides,
  };
}

function demoAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "demo",
    name: "Demo",
    icon: () => null,
    launch: { command: ["demo"] },
    models: [],
    permissionModes: [],
    args: { model: () => [], reasoning: () => [], permissionMode: () => [] },
    ...overrides,
  };
}

const sdk = {} as PragmaClient;

const request: AgentResumeRequest = {
  harnessSessionId: "sess-1",
  selection: { modelId: "m", modeId: "plan" },
  cwd: "/repo",
};

describe("resolveAgentResume", () => {
  it("resolves the qualified agent and passes the plugin context and request", async () => {
    const calls: Array<{ request: AgentResumeRequest; ctx: PluginContext }> = [];
    const resumable = plugin({
      agents: [
        demoAgent({
          launch: {
            command: ["demo"],
            resume: (resumeRequest, ctx) => {
              calls.push({ request: resumeRequest, ctx });
              return ["demo", "--resume", resumeRequest.harnessSessionId];
            },
          },
        }),
      ],
    });

    await expect(
      resolveAgentResume([resumable], sdk, {
        agentId: "pragma.demo",
        projectRoot: "/repo",
        request,
      }),
    ).resolves.toEqual(["demo", "--resume", "sess-1"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toEqual(request);
    expect(calls[0]?.ctx).toMatchObject({
      pluginId: "pragma.demo",
      pluginDir: "/plugins/demo",
      config: { flavor: "demo" },
      project: { id: "/repo", name: "/repo", path: "/repo" },
      sdk,
    });
  });

  it("prefers the project override for its own root and the global copy elsewhere", async () => {
    const globalPlugin = plugin({
      agents: [
        demoAgent({
          launch: { command: ["demo"], resume: () => ["global-demo"] },
        }),
      ],
    });
    const projectPlugin = plugin(
      {
        agents: [
          demoAgent({
            launch: { command: ["demo"], resume: () => ["project-demo"] },
          }),
        ],
      },
      { scope: "project", root: "/repo" },
    );

    await expect(
      resolveAgentResume([globalPlugin, projectPlugin], sdk, {
        agentId: "pragma.demo",
        projectRoot: "/repo",
        request,
      }),
    ).resolves.toEqual(["project-demo"]);
    await expect(
      resolveAgentResume([globalPlugin, projectPlugin], sdk, {
        agentId: "pragma.demo",
        projectRoot: "/other",
        request,
      }),
    ).resolves.toEqual(["global-demo"]);
  });

  it("rejects an unknown agent and an agent without a resume callback", async () => {
    const plugins = [plugin({ agents: [demoAgent()] })];
    await expect(
      resolveAgentResume(plugins, sdk, {
        agentId: "pragma.demo.missing",
        projectRoot: "/repo",
        request,
      }),
    ).rejects.toThrow(/agent not found/);
    await expect(
      resolveAgentResume(plugins, sdk, {
        agentId: "pragma.demo",
        projectRoot: "/repo",
        request,
      }),
    ).rejects.toThrow(/does not support resume/);
  });

  it("surfaces a rejecting callback and a malformed argv as errors", async () => {
    const rejecting = plugin({
      agents: [
        demoAgent({
          launch: {
            command: ["demo"],
            resume: async () => {
              throw new Error("session file unreadable");
            },
          },
        }),
      ],
    });
    await expect(
      resolveAgentResume([rejecting], sdk, {
        agentId: "pragma.demo",
        projectRoot: "/repo",
        request,
      }),
    ).rejects.toThrow("session file unreadable");

    const malformed = plugin({
      agents: [
        demoAgent({
          launch: {
            command: ["demo"],
            resume: () => ["demo\nrm -rf /"],
          },
        }),
      ],
    });
    await expect(
      resolveAgentResume([malformed], sdk, {
        agentId: "pragma.demo",
        projectRoot: "/repo",
        request,
      }),
    ).rejects.toThrow(/control character/);
  });
});

describe("validateResumeArgv", () => {
  it("accepts a non-empty string argv, including empty arguments", () => {
    expect(validateResumeArgv(["demo", "--model", ""])).toEqual(["demo", "--model", ""]);
  });

  it("rejects an empty argv, non-string tokens, and an empty executable", () => {
    expect(() => validateResumeArgv([])).toThrow(/no command/);
    expect(() => validateResumeArgv("demo")).toThrow(/no command/);
    expect(() => validateResumeArgv(["demo", 3])).toThrow(/non-string/);
    expect(() => validateResumeArgv([""])).toThrow(/empty executable/);
  });

  it("rejects tokens carrying NUL, CR, or LF", () => {
    expect(() => validateResumeArgv(["demo\0"])).toThrow(/control character/);
    expect(() => validateResumeArgv(["demo", "x\ry"])).toThrow(/control character/);
    expect(() => validateResumeArgv(["demo", "x\ny"])).toThrow(/control character/);
  });
});
