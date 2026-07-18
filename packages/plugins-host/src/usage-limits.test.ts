import type { PluginDefinition, UsageLimitsResult } from "@pragma/plugin";
import type { PragmaClient } from "@pragma/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ResolvedPlugin } from "./catalog";
import { loadUsageLimits } from "./usage-limits";

function resolvedPlugin(
  id: string,
  title: string,
  load: () => Promise<UsageLimitsResult>,
): ResolvedPlugin {
  return {
    pluginId: `${id}.agent`,
    scope: "bundled",
    root: "/plugins",
    dir: `/plugins/${id}`,
    mainPath: `/plugins/${id}/dist/main.mjs`,
    config: undefined,
    definition: {
      name: title,
      __apiVersion: "0.0.0",
      usageLimits: [
        {
          id,
          title,
          dashboardUrl: "https://example.com/usage",
          primaryLimitId: "daily",
          load,
        },
      ],
    } satisfies PluginDefinition,
  };
}

describe("loadUsageLimits", () => {
  it("loads matching providers with plugin-specific context", async () => {
    const load = vi.fn(async () => ({
      status: "ready" as const,
      observedAt: 10,
      limits: [{ id: "daily", title: "Daily", used: 1, limit: 10 }],
    }));
    const plugins: ResolvedPlugin[] = [
      {
        pluginId: "test.agent",
        scope: "project",
        root: "/repo",
        dir: "/plugins/agent",
        mainPath: "/plugins/agent/dist/main.mjs",
        config: { account: "work" },
        definition: {
          name: "Agent",
          __apiVersion: "0.0.0",
          usageLimits: [
            {
              id: "agent",
              title: "Agent",
              dashboardUrl: "https://example.com/usage",
              primaryLimitId: "daily",
              load,
            },
          ],
        } satisfies PluginDefinition,
      },
    ];

    const results = await loadUsageLimits(plugins, {} as PragmaClient, "/repo", "test.agent");

    expect(results).toEqual([
      {
        pluginId: "test.agent",
        providerId: "agent",
        title: "Agent",
        result: {
          status: "ready",
          observedAt: 10,
          limits: [{ id: "daily", title: "Daily", used: 1, limit: 10 }],
        },
      },
    ]);
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "test.agent",
        pluginDir: "/plugins/agent",
        config: { account: "work" },
        project: { id: "/repo", name: "/repo", path: "/repo" },
      }),
    );
  });

  it("returns empty when plugin has no provider", async () => {
    expect(await loadUsageLimits([], {} as PragmaClient, undefined, "missing")).toEqual([]);
  });

  it("returns unavailable for a failed provider without discarding other providers", async () => {
    const failingLoad = vi.fn(async () => {
      throw new Error("Codex app-server did not return usage data");
    });
    const readyLoad = vi.fn(async () => ({
      status: "ready" as const,
      observedAt: 10,
      limits: [{ id: "daily", title: "Daily", used: 1, limit: 10 }],
    }));
    const results = await loadUsageLimits(
      [
        resolvedPlugin("codex", "Codex", failingLoad),
        resolvedPlugin("claude", "Claude", readyLoad),
      ],
      {} as PragmaClient,
      undefined,
    );

    expect(results).toEqual([
      {
        pluginId: "codex.agent",
        providerId: "codex",
        title: "Codex",
        result: {
          status: "unavailable",
          reason: "error",
          message: "Codex app-server did not return usage data",
        },
      },
      {
        pluginId: "claude.agent",
        providerId: "claude",
        title: "Claude",
        result: {
          status: "ready",
          observedAt: 10,
          limits: [{ id: "daily", title: "Daily", used: 1, limit: 10 }],
        },
      },
    ]);
  });
});
