import type { PluginDefinition } from "@pragma-sh/plugin";
import type { PragmaClient } from "@pragma-sh/sdk";
import { describe, expect, it, vi } from "vitest";

import { handleAccountsOp, listAccountProviders, winningPlugins, withAccountEnv } from "./accounts";
import type { ResolvedPlugin } from "./catalog";

function plugin(
  definition: Omit<PluginDefinition, "__apiVersion">,
  overrides: Partial<ResolvedPlugin> = {},
): ResolvedPlugin {
  return {
    pluginId: "pragma.claude-code",
    scope: "global",
    root: "/plugins",
    dir: "/plugins/claude",
    mainPath: "/plugins/claude/dist/main.mjs",
    config: undefined,
    definition: { ...definition, __apiVersion: "0.0.0" },
    ...overrides,
  };
}

function fakeSdk(): { sdk: PragmaClient; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => [
    { command: "x", stdout: "", stderr: "", status: 0, durationMs: 1 },
  ]);
  return { sdk: { exec: { run } } as unknown as PragmaClient, run };
}

const claude = plugin({
  name: "Claude Code",
  agents: [
    {
      id: "claude-code",
      name: "Claude Code",
      icon: () => null,
      launch: { command: ["claude"] },
      models: [],
      permissionModes: [],
      args: { model: () => [], reasoning: () => [], permissionMode: () => [] },
    },
  ],
  accounts: [
    {
      provider: "anthropic",
      agent: "claude-code",
      login: { command: ["claude", "auth", "login"], instructions: "Finish in the browser." },
      env: (home) => ({ CLAUDE_CONFIG_DIR: home }),
      credentialPath: (home) => `${home ?? "~/.claude"}/.credentials.json`,
      identify: async (ctx) => {
        await ctx.sdk.exec.run({ cwd: "/", commands: ["claude auth status --json"] });
        return { id: "org-1", email: "a@b.c" };
      },
      usageLimits: {
        primaryLimitId: "five-hour",
        load: async () => ({ status: "ready", observedAt: 1, limits: [] }),
      },
    },
  ],
});

describe("listAccountProviders", () => {
  it("reports wire metadata with qualified harness ids", async () => {
    expect(await listAccountProviders([claude], fakeSdk().sdk)).toEqual([
      {
        pluginId: "pragma.claude-code",
        providerId: "anthropic:claude-code",
        provider: "anthropic",
        title: "Anthropic",
        agentIds: ["pragma.claude-code"],
        dashboardUrl: null,
        iconPath: null,
        pluginDir: "/plugins/claude",
        hasLogin: true,
        loginInstructions: "Finish in the browser.",
        multiAccount: true,
        swaps: false,
        sharedTokenKind: null,
        sharedTokenWritable: false,
        identifies: true,
        legacy: false,
        primaryLimitId: "five-hour",
        refreshIntervalMs: null,
      },
    ]);
  });
});

describe("available", () => {
  const offered = (available?: () => Promise<boolean>) =>
    plugin(
      {
        name: "Multi",
        agents: claude.definition.agents ?? [],
        accounts: [{ provider: "openrouter", ...(available ? { available } : {}) }],
      },
      { pluginId: "acme" },
    );

  it("lists a provider the harness offers, or that cannot say", async () => {
    const { sdk } = fakeSdk();
    expect(await listAccountProviders([offered(async () => true)], sdk)).toHaveLength(1);
    expect(await listAccountProviders([offered()], sdk)).toHaveLength(1);
  });

  it("leaves out a provider the harness no longer offers", async () => {
    expect(await listAccountProviders([offered(async () => false)], fakeSdk().sdk)).toEqual([]);
  });

  it("keeps the provider when the harness cannot be asked", async () => {
    const failing = offered(async () => {
      throw new Error("offline");
    });
    expect(await listAccountProviders([failing], fakeSdk().sdk)).toHaveLength(1);
  });
});

describe("handleAccountsOp", () => {
  it("returns a login's env, credential path, and command", async () => {
    const { sdk } = fakeSdk();
    await expect(
      handleAccountsOp([claude], sdk, {
        op: "launch",
        pluginId: "pragma.claude-code",
        providerId: "anthropic:claude-code",
        home: "/h/1",
      }),
    ).resolves.toEqual({
      env: { CLAUDE_CONFIG_DIR: "/h/1" },
      credentialPath: "/h/1/.credentials.json",
      loginCommand: ["claude", "auth", "login"],
      loginInput: [],
      loginInputDelayMs: null,
      instructions: "Finish in the browser.",
    });
  });

  it("gives the default login no env", async () => {
    const { sdk } = fakeSdk();
    const launch = await handleAccountsOp([claude], sdk, {
      op: "launch",
      pluginId: "pragma.claude-code",
      providerId: "anthropic:claude-code",
      home: null,
    });
    expect(launch).toMatchObject({ env: {}, credentialPath: "~/.claude/.credentials.json" });
  });

  it("identifies under the login's env", async () => {
    const { sdk, run } = fakeSdk();
    const identity = await handleAccountsOp([claude], sdk, {
      op: "identify",
      pluginId: "pragma.claude-code",
      providerId: "anthropic:claude-code",
      home: "/h/1",
    });
    expect(identity).toEqual({ id: "org-1", email: "a@b.c" });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ env: [["CLAUDE_CONFIG_DIR", "/h/1"]] }),
    );
  });

  it("rejects an unknown provider", async () => {
    const { sdk } = fakeSdk();
    await expect(
      handleAccountsOp([claude], sdk, { op: "usage", pluginId: "x", providerId: "y", home: null }),
    ).rejects.toThrow("account provider not found");
  });
});

describe("withAccountEnv", () => {
  it("lets an explicit caller env entry win", async () => {
    const { sdk, run } = fakeSdk();
    await withAccountEnv(sdk, { A: "1", B: "2" }).exec.run({
      cwd: "/",
      commands: [],
      env: [["B", "caller"]],
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        env: [
          ["A", "1"],
          ["B", "caller"],
        ],
      }),
    );
  });
});

describe("winningPlugins", () => {
  it("prefers the requested project's copy and ignores other projects", () => {
    const project = { ...claude, scope: "project" as const, root: "/repo" };
    const other = { ...claude, scope: "project" as const, root: "/elsewhere" };
    expect(winningPlugins([claude, project, other], "/repo")).toEqual([project]);
    expect(winningPlugins([claude, other], "/repo")).toEqual([claude]);
  });
});
