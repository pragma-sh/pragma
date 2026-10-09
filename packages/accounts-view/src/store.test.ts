import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountsListResult } from "@pragma-sh/constants";
import type { AccountsApi } from "@pragma-sh/sdk";

import { ProjectAccounts } from "./store";

const list: AccountsListResult = {
  providers: [
    {
      pluginId: "p",
      providerId: "anthropic",
      provider: "anthropic",
      title: "Anthropic",
      agentIds: ["a", "b"],
      dashboardUrl: null,
      iconPath: null,
      pluginDir: null,
      hasLogin: true,
      loginInstructions: null,
      multiAccount: true,
      identifies: true,
      legacy: false,
      primaryLimitId: "five-hour",
      refreshIntervalMs: null,
    },
  ],
  state: {
    version: 1,
    logins: [
      {
        id: "l1",
        pluginId: "p",
        providerId: "anthropic",
        provider: "anthropic",
        agentId: "a",
        home: null,
        credentialPath: null,
        identity: { id: "org" },
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    labels: {},
    bindings: { global: {}, projects: {} },
  },
  loginKeys: { l1: "anthropic:org", l2: "anthropic:org" },
  effective: [],
  sessions: [],
};

function fakeApi(usageResult: unknown) {
  return {
    list: vi.fn(async () => list),
    refresh: vi.fn(async () => list),
    usage: vi.fn(async () => [{ accountKey: "anthropic:org", loginId: "l1", result: usageResult }]),
  };
}

describe("ProjectAccounts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("identifies on first subscribe and loads usage once per account", async () => {
    const api = fakeApi({
      status: "ready",
      observedAt: 1,
      limits: [{ id: "five-hour", title: "5-hour", used: 10, limit: 100 }],
    });
    const store = new ProjectAccounts(api as unknown as AccountsApi);
    const stop = store.subscribe(() => {});
    await vi.waitFor(() => expect(store.getSnapshot().usage.size).toBe(1));
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.usage).toHaveBeenCalledWith(null, ["anthropic:org"]);
    stop();
  });

  it("turns an invalid usage result into an unavailable error and backs off", async () => {
    const api = fakeApi({ status: "ready", observedAt: 1, limits: [] });
    const store = new ProjectAccounts(api as unknown as AccountsApi);
    const stop = store.subscribe(() => {});
    await vi.waitFor(() => expect(store.getSnapshot().usage.size).toBe(1));
    expect(store.getSnapshot().usage.get("anthropic:org")).toMatchObject({
      status: "unavailable",
      reason: "error",
    });
    api.usage.mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.usage).not.toHaveBeenCalled();
    stop();
  });
});
