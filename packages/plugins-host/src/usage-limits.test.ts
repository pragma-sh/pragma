import type { PluginDefinition, UsageLimitsResult } from "@pragma/plugin";
import type { PragmaClient } from "@pragma/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ResolvedPlugin } from "./catalog";
import { assembleUsageProviders, loadUsageLimits, validateResult } from "./usage-limits";

function resolvedPlugin(
  id: string,
  title: string,
  load: () => Promise<UsageLimitsResult>,
  overrides: Partial<ResolvedPlugin> = {},
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
    ...overrides,
  };
}

const readyResult = {
  status: "ready" as const,
  observedAt: 10,
  limits: [{ id: "daily", title: "Daily", used: 1, limit: 10 }],
};

describe("loadUsageLimits", () => {
  it("loads matching providers with plugin-specific context and metadata", async () => {
    const load = vi.fn(async () => readyResult);
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
              refreshIntervalMs: 60_000,
              load,
            },
          ],
        } satisfies PluginDefinition,
      },
    ];

    const results = await loadUsageLimits(plugins, {} as PragmaClient, "/repo", {
      pluginId: "test.agent",
    });

    expect(results).toEqual([
      {
        pluginId: "test.agent",
        providerId: "agent",
        title: "Agent",
        dashboardUrl: "https://example.com/usage",
        primaryLimitId: "daily",
        refreshIntervalMs: 60_000,
        result: readyResult,
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

  it("returns empty when no plugin matches", async () => {
    expect(
      await loadUsageLimits([], {} as PragmaClient, undefined, { pluginId: "missing" }),
    ).toEqual([]);
  });

  it("hides a project-scoped provider from another project's scope", async () => {
    const load = vi.fn(async () => readyResult);
    const plugins = [
      resolvedPlugin("mine", "Mine", load, { scope: "project", root: "/repo" }),
      resolvedPlugin("theirs", "Theirs", load, { scope: "project", root: "/other" }),
    ];

    const results = await loadUsageLimits(plugins, {} as PragmaClient, "/repo", {});

    expect(results.map((provider) => provider.pluginId)).toEqual(["mine.agent"]);
  });

  it("returns unavailable for a failed provider without discarding other providers", async () => {
    const failingLoad = vi.fn(async () => {
      throw new Error("Codex app-server did not return usage data");
    });
    const readyLoad = vi.fn(async () => readyResult);

    const results = await loadUsageLimits(
      [
        resolvedPlugin("codex", "Codex", failingLoad),
        resolvedPlugin("claude", "Claude", readyLoad),
      ],
      {} as PragmaClient,
      undefined,
      {},
    );

    expect(results.map((provider) => provider.result)).toEqual([
      {
        status: "unavailable",
        reason: "error",
        message: "Codex app-server did not return usage data",
      },
      readyResult,
    ]);
  });

  it("reports a provider that omits its primary limit as unavailable", async () => {
    const load = vi.fn(async () => ({
      status: "ready" as const,
      observedAt: 10,
      limits: [{ id: "weekly", title: "Weekly", used: 1, limit: 10 }],
    }));

    const [provider] = await loadUsageLimits(
      [resolvedPlugin("codex", "Codex", load)],
      {} as PragmaClient,
      undefined,
      {},
    );

    expect(provider?.result).toEqual({
      status: "unavailable",
      reason: "error",
      message: 'Codex did not return primary limit "daily"',
    });
  });

  it("prefers metadata already resolved at catalog time", async () => {
    const load = vi.fn(async () => readyResult);
    const plugins = [resolvedPlugin("codex", "Codex", load)];
    const known = [
      {
        pluginId: "codex.agent",
        providerId: "codex",
        title: "Codex",
        dashboardUrl: "https://example.com/usage",
        primaryLimitId: "daily",
        icon: { hash: "abc", mime: "image/svg+xml" },
      },
    ];

    const [provider] = await loadUsageLimits(plugins, {} as PragmaClient, undefined, { known });

    expect(provider?.icon).toEqual({ hash: "abc", mime: "image/svg+xml" });
  });
});

describe("assembleUsageProviders", () => {
  it("collects metadata and skips a browser-URL icon", () => {
    const plugins = [resolvedPlugin("codex", "Codex", async () => readyResult)];
    plugins[0]!.definition.usageLimits![0]!.iconPath = "https://example.com/icon.svg";

    expect(assembleUsageProviders(plugins, {})).toEqual([
      {
        pluginId: "codex.agent",
        providerId: "codex",
        title: "Codex",
        dashboardUrl: "https://example.com/usage",
        primaryLimitId: "daily",
      },
    ]);
  });

  it("keeps the provider and reports the error when its icon file is unreadable", () => {
    const plugins = [resolvedPlugin("codex", "Codex", async () => readyResult)];
    plugins[0]!.definition.usageLimits![0]!.iconPath = "missing.svg";
    const onError = vi.fn();

    const providers = assembleUsageProviders(plugins, {}, onError);

    expect(providers[0]?.icon).toBeUndefined();
    expect(onError).toHaveBeenCalledWith("codex.agent", "codex", expect.any(Error));
  });
});

describe("validateResult", () => {
  const definition = { title: "Codex", primaryLimitId: "daily" };

  it("passes an unavailable result through unchecked", () => {
    const result = {
      status: "unavailable" as const,
      reason: "not-configured" as const,
      message: "Sign in",
    };
    expect(validateResult(definition, result)).toBe(result);
  });

  it("rejects a duplicate category", () => {
    expect(() =>
      validateResult(definition, {
        status: "ready",
        observedAt: 1,
        limits: [
          { id: "daily", title: "Daily", used: 1, limit: 2 },
          { id: "daily", title: "Daily", used: 1, limit: 2 },
        ],
      }),
    ).toThrow("Codex returned an invalid usage limit");
  });

  it("rejects a non-finite observation time", () => {
    expect(() =>
      validateResult(definition, { status: "ready", observedAt: Number.NaN, limits: [] }),
    ).toThrow("Codex returned an invalid observation time");
  });

  it("accepts a summary standing in for the primary limit", () => {
    const result = {
      status: "ready" as const,
      observedAt: 1,
      summary: { id: "daily", title: "Daily", used: 1, limit: 2 },
      limits: [{ id: "weekly", title: "Weekly", used: 1, limit: 2 }],
    };
    expect(validateResult(definition, result)).toBe(result);
  });

  it("accepts an unlimited category", () => {
    const result = {
      status: "ready" as const,
      observedAt: 1,
      limits: [{ id: "daily", title: "Daily", used: 5, limit: null }],
    };
    expect(validateResult(definition, result)).toBe(result);
  });
});
