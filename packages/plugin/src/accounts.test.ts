import { describe, expect, it } from "vitest";
import {
  accountProviderFromUsageLimits,
  accountProviderTitle,
  defineAccounts,
  modelsDevAccountProviders,
  resolveAccountProviders,
} from "./accounts";
import { definePlugin } from "./plugin";
import type { PluginContext } from "./types";
import { defineUsageLimitProvider, type UsageLimitsResult } from "./usage-limits";

const ready: UsageLimitsResult = { status: "ready", observedAt: 1, limits: [] };

const legacy = defineUsageLimitProvider({
  id: "cursor",
  title: "Cursor",
  dashboardUrl: "https://cursor.com/dashboard/spending",
  iconPath: "assets/cursor.svg",
  primaryLimitId: "api",
  refreshIntervalMs: 60_000,
  load: async () => ready,
});

describe("defineAccounts", () => {
  it("is preserved by definePlugin", () => {
    const accounts = defineAccounts([{ provider: "anthropic", agent: "claude-code" }]);
    expect(definePlugin({ name: "Test", accounts }).accounts).toEqual(accounts);
  });
});

describe("resolveAccountProviders", () => {
  it("fills well-known titles and scopes ids by agent", () => {
    const [provider] = resolveAccountProviders({
      accounts: [{ provider: "anthropic", agent: "claude-code" }],
    });
    expect(provider).toMatchObject({
      id: "anthropic:claude-code",
      title: "Anthropic",
      legacy: false,
    });
  });

  it("defaults the dashboard to the well-known provider's", () => {
    const [openrouter, custom] = resolveAccountProviders({
      accounts: [
        { provider: "openrouter", agent: "opencode" },
        { provider: "openrouter", agent: "pi", dashboardUrl: "https://example.com" },
      ],
    });
    expect(openrouter?.dashboardUrl).toBe("https://openrouter.ai/settings/keys");
    expect(custom?.dashboardUrl).toBe("https://example.com");
  });

  it("lists API-key providers by models.dev id, minus the harness's own sign-ins", () => {
    const providers = modelsDevAccountProviders(["openai"]);
    expect(providers.find((entry) => entry.provider === "zai")?.modelsDevIds[0]).toBe(
      "zai-coding-plan",
    );
    expect(providers.map((entry) => entry.provider)).not.toContain("openai");
    // Subscription-only sign-ins have no API key to list.
    expect(providers.map((entry) => entry.provider)).not.toContain("github-copilot");
    expect(providers.map((entry) => entry.provider)).not.toContain("cursor");
  });

  it("serves a provider's own agent, or else every agent", () => {
    const resolved = resolveAccountProviders({
      agents: [{ id: "a" }, { id: "b" }],
      accounts: [{ provider: "openrouter" }, { provider: "anthropic", agent: "b" }],
    });
    expect(resolved.map((provider) => [provider.id, provider.agentIds])).toEqual([
      ["openrouter", ["a", "b"]],
      ["anthropic:b", ["b"]],
    ]);
  });

  it("keeps an explicit title and unknown provider keys", () => {
    expect(accountProviderTitle("acme", "Acme AI")).toBe("Acme AI");
    expect(accountProviderTitle("acme")).toBe("acme");
  });

  it("adapts deprecated usage-limit providers into single-login providers", () => {
    const [provider] = resolveAccountProviders({ usageLimits: [legacy] });
    expect(provider).toMatchObject({
      id: "cursor",
      provider: "cursor",
      title: "Cursor",
      dashboardUrl: legacy.dashboardUrl,
      iconPath: "assets/cursor.svg",
      legacy: true,
      usageLimits: { primaryLimitId: "api", refreshIntervalMs: 60_000 },
    });
    expect(provider?.login).toBeUndefined();
    expect(provider?.env).toBeUndefined();
  });

  it("forwards the account context to the legacy loader", async () => {
    const provider = accountProviderFromUsageLimits(legacy);
    const ctx = { pluginId: "p" } as unknown as PluginContext;
    await expect(
      provider.usageLimits?.load({ ...ctx, account: { loginId: "default", home: null, env: {} } }),
    ).resolves.toEqual(ready);
  });

  it("drops a legacy provider whose id is already declared as an account provider", () => {
    const resolved = resolveAccountProviders({
      accounts: [{ provider: "cursor", agent: "cursor" }],
      usageLimits: [legacy],
    });
    expect(resolved.map((provider) => provider.id)).toEqual(["cursor:cursor"]);
  });
});
