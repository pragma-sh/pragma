import { buildProviderViews, type ProviderView } from "@pragma-sh/accounts-view";
import type { AccountLogin, AccountProviderInfo, AccountsListResult } from "@pragma-sh/constants";
import { describe, expect, it } from "vitest";

import { switchMenuActions, switchTarget } from "./account-switch";

const claude: AccountProviderInfo = {
  pluginId: "pragma.claude-code",
  providerId: "anthropic:claude-code",
  provider: "anthropic",
  title: "Anthropic",
  agentIds: ["pragma.claude-code"],
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
};

/** OpenCode can only use an API key for Anthropic, never a Claude sign-in. */
const opencode: AccountProviderInfo = {
  ...claude,
  pluginId: "pragma.opencode",
  providerId: "anthropic:opencode",
  agentIds: ["pragma.opencode"],
  hasLogin: false,
  multiAccount: false,
  sharedTokenKind: "key:anthropic",
};

function login(id: string, agentId: string, identity: string, home: string | null): AccountLogin {
  return {
    id,
    pluginId: agentId,
    providerId: "anthropic",
    provider: "anthropic",
    agentId,
    home,
    credentialPath: null,
    identity: { id: identity, email: `${identity}@example.com` },
    createdAt: 0,
    updatedAt: 0,
  };
}

const list: AccountsListResult = {
  providers: [claude, opencode],
  state: {
    version: 1,
    logins: [
      login("home", "pragma.claude-code", "home", null),
      login("work", "pragma.claude-code", "work", "/h/work"),
    ],
    labels: {},
    bindings: { global: {}, projects: {} },
  },
  loginKeys: { home: "anthropic:home", work: "anthropic:work" },
  effective: [
    {
      agentId: "pragma.claude-code",
      provider: "anthropic",
      accountKey: "anthropic:home",
      loginId: "home",
      scope: null,
    },
  ],
  sessions: [],
};

function anthropic(): ProviderView {
  const [provider] = buildProviderViews({ list, usage: new Map() }, (id) =>
    id === "pragma.opencode" ? "OpenCode" : "Claude Code",
  );
  if (!provider) throw new Error("no provider view");
  return provider;
}

describe("switchMenuActions", () => {
  it("offers every usable account and checks the current one", () => {
    const provider = anthropic();
    const harness = provider.harnesses.find((entry) => entry.agentId === "pragma.claude-code")!;

    expect(switchMenuActions(provider, harness)).toEqual([
      { id: "switch:anthropic:home", title: "home@example.com", state: "on" },
      { id: "switch:anthropic:work", title: "work@example.com", state: "off" },
    ]);
  });

  it("keeps unusable accounts visible but disabled, with the reason", () => {
    const provider = anthropic();
    const harness = provider.harnesses.find((entry) => entry.agentId === "pragma.opencode")!;

    const actions = switchMenuActions(provider, harness);
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.attributes).toEqual({ disabled: true });
      expect(action.subtitle).toBe("OpenCode can only use an API key for Anthropic");
    }
  });
});

describe("switchTarget", () => {
  it("reads the account key back out of a switch action", () => {
    expect(switchTarget("switch:anthropic:work")).toBe("anthropic:work");
    expect(switchTarget("dashboard")).toBeNull();
  });
});
