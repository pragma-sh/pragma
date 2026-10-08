import { describe, expect, it } from "vitest";

import type { AccountLogin, AccountProviderInfo, AccountsListResult } from "@pragma-sh/constants";
import type { UsageLimitsResult } from "@pragma-sh/plugin";

import {
  autoSelectUsage,
  buildProviderViews,
  chipHarnesses,
  globalHarnessView,
  harnessAccountChoices,
  inUseProviders,
  shownProviders,
  staleSessionCount,
  switchScope,
  unassignedHarnesses,
  type HarnessView,
  type ProviderView,
} from "./accounts";

const anthropic: AccountProviderInfo = {
  pluginId: "pragma.claude-code",
  providerId: "anthropic:claude-code",
  provider: "anthropic",
  title: "Anthropic",
  agentIds: ["pragma.claude-code"],
  dashboardUrl: "https://claude.ai/settings/usage",
  iconPath: "assets/claude-code.svg",
  pluginDir: "/plugins/claude",
  hasLogin: true,
  loginInstructions: null,
  multiAccount: true,
  identifies: true,
  legacy: false,
  primaryLimitId: "five-hour",
  refreshIntervalMs: 300_000,
};

const opencodeAnthropic: AccountProviderInfo = {
  ...anthropic,
  pluginId: "pragma.opencode",
  providerId: "anthropic:opencode",
  agentIds: ["pragma.opencode"],
  iconPath: null,
};

function login(
  id: string,
  agentId: string,
  identity: string | null,
  home: string | null = null,
): AccountLogin {
  return {
    id,
    pluginId: "p",
    providerId: "anthropic",
    provider: "anthropic",
    agentId,
    home,
    credentialPath: null,
    identity: identity ? { id: identity, email: `${identity}@example.com` } : null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function ready(percent: number): UsageLimitsResult {
  return {
    status: "ready",
    observedAt: 1,
    limits: [{ id: "five-hour", title: "5-hour", used: percent, limit: 100 }],
  };
}

const list: AccountsListResult = {
  providers: [anthropic, opencodeAnthropic],
  state: {
    version: 1,
    logins: [
      login("d1", "pragma.claude-code", "home"),
      login("w1", "pragma.claude-code", "work", "/h/w1"),
      login("d2", "pragma.opencode", "home"),
    ],
    labels: { "anthropic:work": "Work" },
    bindings: { global: {}, projects: {} },
  },
  loginKeys: { d1: "anthropic:home", w1: "anthropic:work", d2: "anthropic:home" },
  effective: [
    {
      agentId: "pragma.claude-code",
      provider: "anthropic",
      accountKey: "anthropic:work",
      loginId: "w1",
      scope: "project",
    },
    {
      agentId: "pragma.opencode",
      provider: "anthropic",
      accountKey: "anthropic:home",
      loginId: "d2",
      scope: null,
    },
  ],
  sessions: [
    {
      tabId: "t1",
      agentId: "pragma.claude-code",
      provider: "anthropic",
      accountKey: "anthropic:home",
    },
  ],
};

const names = (agentId: string) => (agentId === "pragma.opencode" ? "OpenCode" : "Claude Code");

describe("buildProviderViews", () => {
  const usage = new Map([
    ["anthropic:home", ready(38)],
    ["anthropic:work", ready(82)],
  ]);
  const [provider] = buildProviderViews({ list, usage }, names);

  it("merges plugins that declare the same provider into one row", () => {
    expect(provider?.title).toBe("Anthropic");
    expect(provider?.harnesses.map((harness) => harness.name)).toEqual(["Claude Code", "OpenCode"]);
    expect(provider?.iconPath).toBe("assets/claude-code.svg");
  });

  it("groups logins by account key and labels them", () => {
    expect(provider?.accounts.map((account) => account.label)).toEqual([
      "home@example.com",
      "Work",
    ]);
    const home = provider?.accounts.find((account) => account.key === "anthropic:home");
    expect(home?.logins.map((entry) => entry.id)).toEqual(["d1", "d2"]);
  });

  it("reports which harness uses each account and why", () => {
    const work = provider?.accounts.find((account) => account.key === "anthropic:work");
    expect(work?.usedBy).toEqual([{ agentId: "pragma.claude-code", scope: "project" }]);
  });

  it("shows the worst in-use usage, not the average", () => {
    expect(provider?.worstPercent).toBe(82);
  });
});

describe("inUseProviders", () => {
  const views = buildProviderViews({ list, usage: new Map() }, names);

  it("keeps a provider a harness launches with", () => {
    expect(inUseProviders(views).map((view) => view.provider)).toEqual(["anthropic"]);
  });

  it("drops a provider none of whose accounts is in use", () => {
    const idle = views.map((view) => ({
      ...view,
      accounts: view.accounts.map((account) => ({ ...account, usedBy: [] })),
    }));
    expect(inUseProviders(idle)).toEqual([]);
  });
});

describe("staleSessionCount", () => {
  it("counts sessions still running on another account", () => {
    expect(staleSessionCount(list, "pragma.claude-code", "anthropic", "anthropic:work")).toBe(1);
    expect(staleSessionCount(list, "pragma.claude-code", "anthropic", "anthropic:home")).toBe(0);
  });
});

describe("switchScope", () => {
  it("writes globally unless this project already overrides the harness", () => {
    const [provider] = buildProviderViews({ list, usage: new Map() }, names);
    expect(switchScope(provider?.harnesses[0])).toBe("project");
    expect(switchScope(provider?.harnesses[1])).toBe("global");
  });
});

function harnessOf(view: ProviderView, agentId: string): HarnessView {
  return view.harnesses.find((candidate) => candidate.agentId === agentId)!;
}

/** Account keys by how `harness` could use them. */
function choicesOf(view: ProviderView, agentId: string): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const choice of harnessAccountChoices(view, harnessOf(view, agentId))) {
    const label =
      choice.status === "ready" ? (choice.borrowed ? "borrowed" : "own") : choice.status;
    (grouped[label] ??= []).push(choice.account.key);
  }
  return grouped;
}

describe("harnessAccountChoices", () => {
  const codex: AccountProviderInfo = {
    ...anthropic,
    pluginId: "pragma.codex",
    providerId: "openai:codex",
    provider: "openai",
    agentIds: ["pragma.codex"],
    sharedTokenKind: "chatgpt",
    sharedTokenWritable: true,
  };
  const pi: AccountProviderInfo = {
    ...codex,
    pluginId: "pragma.pi",
    providerId: "openai:pi",
    agentIds: ["pragma.pi"],
  };
  const openai = (id: string, agentId: string, info: AccountProviderInfo, who: string) => ({
    ...login(id, agentId, who, `/h/${id}`),
    pluginId: info.pluginId,
    providerId: info.providerId,
    provider: "openai",
  });
  const sharedList = (providers: AccountProviderInfo[]): AccountsListResult => ({
    providers,
    state: {
      ...list.state,
      logins: [
        openai("c1", "pragma.codex", codex, "work"),
        openai("c2", "pragma.codex", codex, "home"),
        openai("p1", "pragma.pi", pi, "home"),
      ],
      bindings: { global: {}, projects: {} },
    },
    loginKeys: { c1: "openai:work", c2: "openai:home", p1: "openai:home" },
    effective: [],
    sessions: [],
  });

  it("lists every account, own logins first", () => {
    const [view] = buildProviderViews({ list, usage: new Map() }, names);
    expect(choicesOf(view!, "pragma.claude-code")).toEqual({
      own: ["anthropic:home", "anthropic:work"],
    });
    // OpenCode never signed in to "work", but can sign in to another account.
    expect(choicesOf(view!, "pragma.opencode")).toEqual({
      own: ["anthropic:home"],
      signIn: ["anthropic:work"],
    });
  });

  it("offers an account whose sign-in the harness can borrow", () => {
    const [view] = buildProviderViews({ list: sharedList([codex, pi]), usage: new Map() }, names);
    expect(choicesOf(view!, "pragma.pi")).toEqual({
      own: ["openai:home"],
      borrowed: ["openai:work"],
    });
  });

  it("says why an account cannot be used", () => {
    // Only lends its sign-in (Kimi Code), and has no login command to sign in.
    const lender = { ...pi, sharedTokenWritable: false, hasLogin: false };
    const [view] = buildProviderViews(
      { list: sharedList([codex, lender]), usage: new Map() },
      names,
    );
    const unusable = harnessAccountChoices(view!, harnessOf(view!, "pragma.pi")).find(
      (choice) => choice.status === "unavailable",
    );
    expect(unusable).toMatchObject({
      account: { key: "openai:work" },
      reason: "Sign in to it inside Claude Code",
    });
    // A harness that only takes API keys cannot use a subscription sign-in.
    const keysOnly = { ...pi, sharedTokenKind: "key:openai" };
    const [keyView] = buildProviderViews(
      { list: sharedList([codex, keysOnly]), usage: new Map() },
      names,
    );
    expect(
      harnessAccountChoices(keyView!, harnessOf(keyView!, "pragma.pi")).find(
        (choice) => choice.account.key === "openai:work",
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "Claude Code can only use an API key for Anthropic",
    });
  });
});

describe("chipHarnesses", () => {
  it("drops a harness whose every option would be disabled", () => {
    const keysOnly: AccountProviderInfo = {
      ...opencodeAnthropic,
      pluginId: "pragma.kimi",
      providerId: "anthropic:kimi",
      agentIds: ["pragma.kimi"],
      hasLogin: false,
      multiAccount: false,
      sharedTokenKind: "key:anthropic",
    };
    const withKimi: AccountsListResult = { ...list, providers: [...list.providers, keysOnly] };
    const [view] = buildProviderViews({ list: withKimi, usage: new Map() }, names);
    expect(chipHarnesses(view!, view!.harnesses).map((harness) => harness.agentId)).toEqual([
      "pragma.claude-code",
      "pragma.opencode",
    ]);
  });

  it("drops a key-only harness that could sign in, while the provider lists no API key", () => {
    const keyOnlyOpenCode: AccountProviderInfo = {
      ...opencodeAnthropic,
      hasLogin: true,
      multiAccount: true,
      sharedTokenKind: "key:anthropic",
    };
    const subscriptionOnly: AccountsListResult = {
      ...list,
      providers: [anthropic, keyOnlyOpenCode],
      state: {
        ...list.state,
        logins: list.state.logins.filter((entry) => entry.agentId !== "pragma.opencode"),
      },
      effective: list.effective.filter((binding) => binding.agentId !== "pragma.opencode"),
    };
    const [view] = buildProviderViews({ list: subscriptionOnly, usage: new Map() }, names);
    expect(chipHarnesses(view!, view!.harnesses).map((harness) => harness.agentId)).toEqual([
      "pragma.claude-code",
    ]);
  });
});

describe("unassignedHarnesses", () => {
  it("lists harnesses on no listed account", () => {
    const unbound: AccountsListResult = {
      ...list,
      effective: list.effective.filter((entry) => entry.agentId !== "pragma.opencode"),
    };
    const [view] = buildProviderViews({ list: unbound, usage: new Map() }, names);
    expect(unassignedHarnesses(view!).map((h) => h.agentId)).toEqual(["pragma.opencode"]);
    const [bound] = buildProviderViews({ list, usage: new Map() }, names);
    expect(unassignedHarnesses(bound!)).toEqual([]);
  });
});

describe("globalHarnessView", () => {
  it("hides a project override behind the harness's own login", () => {
    const [view] = buildProviderViews({ list, usage: new Map() }, names);
    const claude = view!.harnesses[0]!;
    expect(globalHarnessView(claude, view!, list).current).toMatchObject({
      accountKey: "anthropic:home",
      scope: null,
    });
  });

  it("shows the global choice behind a project override", () => {
    const pinned: AccountsListResult = {
      ...list,
      state: {
        ...list.state,
        bindings: {
          ...list.state.bindings,
          global: { "pragma.claude-code": { anthropic: "anthropic:work" } },
        },
      },
    };
    const [view] = buildProviderViews({ list: pinned, usage: new Map() }, names);
    expect(globalHarnessView(view!.harnesses[0]!, view!, pinned).current).toMatchObject({
      accountKey: "anthropic:work",
      scope: "global",
    });
  });

  it("leaves a harness without an override untouched", () => {
    const [view] = buildProviderViews({ list, usage: new Map() }, names);
    const opencode = view!.harnesses[1]!;
    expect(globalHarnessView(opencode, view!, list)).toBe(opencode);
  });
});

describe("signed-out providers", () => {
  const openrouter: AccountProviderInfo = {
    ...opencodeAnthropic,
    providerId: "openrouter:opencode",
    provider: "openrouter",
    title: "OpenRouter",
    multiAccount: false,
    primaryLimitId: null,
  };
  const signedOut: AccountLogin = {
    ...login("default:opencode:openrouter", "pragma.opencode", null),
    pluginId: "pragma.opencode",
    providerId: "openrouter:opencode",
    provider: "openrouter",
  };
  const withOpenRouter = (info: AccountProviderInfo, logins: AccountLogin[]) =>
    buildProviderViews(
      {
        list: {
          ...list,
          providers: [anthropic, opencodeAnthropic, info],
          state: { ...list.state, logins: [...list.state.logins, ...logins] },
        },
        usage: new Map(),
      },
      names,
    );

  it("drops a default login its plugin could not identify", () => {
    const views = withOpenRouter(openrouter, [signedOut]);
    expect(views.find((view) => view.provider === "openrouter")?.accounts).toEqual([]);
  });

  it("keeps the default login of a provider that cannot identify", () => {
    const views = withOpenRouter({ ...openrouter, identifies: false }, [signedOut]);
    expect(views.find((view) => view.provider === "openrouter")?.accounts).toHaveLength(1);
  });

  it("hides a single-login provider with no account until it has one", () => {
    expect(shownProviders(withOpenRouter(openrouter, [signedOut])).map((v) => v.provider)).toEqual([
      "anthropic",
    ]);
    const signedIn = { ...signedOut, identity: { id: "key:abc", name: "API key …1234" } };
    expect(shownProviders(withOpenRouter(openrouter, [signedIn])).map((v) => v.provider)).toEqual([
      "anthropic",
      "openrouter",
    ]);
  });
});

describe("autoSelectUsage", () => {
  it("reports the bound account's limits with resets re-based on now", () => {
    const usage = new Map<string, UsageLimitsResult>([
      [
        "anthropic:work",
        {
          status: "ready",
          observedAt: 1_000,
          limits: [
            { id: "five-hour", title: "5-hour", used: 82, limit: 100, resetsInMs: 60_000 },
            { id: "extra", title: "Extra", used: 4, limit: null },
          ],
        },
      ],
    ]);
    expect(autoSelectUsage({ list, usage }, "pragma.claude-code", 21_000)).toEqual([
      {
        provider: "anthropic",
        title: "Anthropic",
        status: "ready",
        limits: [
          { title: "5-hour", percentUsed: 82, resetsInMs: 40_000, primary: true },
          { title: "Extra", percentUsed: null, resetsInMs: null, primary: false },
        ],
      },
    ]);
  });

  it("marks unloaded and unavailable usage, and skips other harnesses", () => {
    const usage = new Map<string, UsageLimitsResult>([
      [
        "anthropic:home",
        { status: "unavailable", reason: "authentication-required", message: "Sign in" },
      ],
    ]);
    expect(autoSelectUsage({ list, usage: new Map() }, "pragma.claude-code")).toEqual([
      { provider: "anthropic", title: "Anthropic", status: "unknown", limits: [] },
    ]);
    expect(autoSelectUsage({ list, usage }, "pragma.opencode")).toEqual([
      {
        provider: "anthropic",
        title: "Anthropic",
        status: "unavailable",
        message: "Sign in",
        limits: [],
      },
    ]);
    expect(autoSelectUsage({ list, usage }, "pragma.cursor")).toEqual([]);
  });
});
