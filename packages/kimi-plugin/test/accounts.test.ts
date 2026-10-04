import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiKeyIdentity } from "@pragma-sh/plugin/catalog";

import {
  KIMI_API_KEY_PROVIDERS,
  parseKimiCatalogIds,
  parseKimiProviderKeys,
  resetKimiCatalogCache,
} from "../src/accounts";
import { kimiAgentPlugin } from "../src/pragma-plugin";

const LIST = JSON.stringify({
  providers: {
    openrouter: { type: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: "or-key-1" },
    "zai-coding-plan": { type: "anthropic", baseUrl: "https://api.z.ai", apiKey: "zai-key" },
    custom: { type: "openai", baseUrl: "https://example.com" },
  },
  models: {},
});

function context(env: Record<string, string>, run: ReturnType<typeof vi.fn>) {
  return {
    project: { id: "p", name: "p", path: "/p" },
    sdk: { exec: { run } },
    account: { loginId: "default", home: null, env },
  } as never;
}

function byProvider(provider: string) {
  return kimiAgentPlugin.accounts?.find((candidate) => candidate.provider === provider);
}

describe("kimi account providers", () => {
  it("keeps its own Kimi sign-in first and adds the API-key providers", () => {
    expect(kimiAgentPlugin.accounts?.map((provider) => provider.provider)).toEqual([
      "moonshot",
      ...KIMI_API_KEY_PROVIDERS.map((entry) => entry.provider),
    ]);
    expect(KIMI_API_KEY_PROVIDERS.map((entry) => entry.provider)).not.toContain("moonshot");
  });

  // Only `moonshot` may relocate KIMI_CODE_HOME; the rest follow Kimi's config.
  it("gives no other provider a data directory or login command", () => {
    for (const provider of kimiAgentPlugin.accounts ?? []) {
      if (provider.provider === "moonshot") continue;
      expect(provider.agent).toBe("kimi");
      expect(provider.env).toBeUndefined();
      expect(provider.login).toBeUndefined();
    }
  });

  it("reads each provider's key and skips one without a key", () => {
    expect([...parseKimiProviderKeys(LIST).keys()]).toEqual(["openrouter", "zai-coding-plan"]);
    expect(parseKimiProviderKeys("not json").size).toBe(0);
  });

  it("identifies by key digest, sharing one provider listing across rows", async () => {
    const run = vi.fn(async () => [{ stdout: LIST, stderr: "", status: 0 }]);
    const ctx = context({ PRAGMA_TEST: "share" }, run);
    const [openrouter, zai, groq] = await Promise.all([
      byProvider("openrouter")?.identify?.(ctx),
      byProvider("zai")?.identify?.(ctx),
      byProvider("groq")?.identify?.(ctx),
    ]);
    expect(openrouter).toEqual(await apiKeyIdentity("or-key-1"));
    expect(zai).toEqual(await apiKeyIdentity("zai-key"));
    expect(groq).toBeNull();
    expect(JSON.stringify([openrouter, zai])).not.toContain("or-key-1");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports signed out when Kimi cannot be run", async () => {
    const run = vi.fn(async () => {
      throw new Error("kimi missing");
    });
    expect(
      await byProvider("openrouter")?.identify?.(context({ PRAGMA_TEST: "x" }, run)),
    ).toBeNull();
  });
});

function ok(stdout: string) {
  return vi.fn(async () => [{ stdout, stderr: "", status: 0 }]);
}

describe("kimi catalog availability", () => {
  const CATALOG = JSON.stringify({
    openrouter: { id: "openrouter" },
    "zai-coding-plan": { id: "zai-coding-plan" },
  });

  beforeEach(() => resetKimiCatalogCache());

  it("lists a provider only while Kimi's catalog offers one of its ids", async () => {
    const run = ok(CATALOG);
    const ctx = context({}, run);
    const [openrouter, zai, groq] = await Promise.all([
      byProvider("openrouter")?.available?.(ctx),
      byProvider("zai")?.available?.(ctx),
      byProvider("groq")?.available?.(ctx),
    ]);
    expect([openrouter, zai, groq]).toEqual([true, true, false]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps every provider when the catalog is unreadable, and asks again next time", async () => {
    const broken = ok("offline");
    expect(await byProvider("groq")?.available?.(context({}, broken))).toBe(true);
    const run = ok(CATALOG);
    expect(await byProvider("groq")?.available?.(context({}, run))).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reads catalog ids", () => {
    expect([...(parseKimiCatalogIds(CATALOG) ?? [])]).toEqual(["openrouter", "zai-coding-plan"]);
    expect(parseKimiCatalogIds("{}")).toBeNull();
    expect(parseKimiCatalogIds("nope")).toBeNull();
  });
});
