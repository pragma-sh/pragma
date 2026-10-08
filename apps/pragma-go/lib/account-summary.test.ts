import type { AccountView, HarnessView, ProviderView } from "@pragma-sh/accounts-view";
import { describe, expect, it } from "vitest";

import {
  accountUsers,
  currentAccountLabel,
  providerSummary,
  usageStatusMessage,
} from "./account-summary";

function account(key: string, percent: number | null, usedBy: string[] = []): AccountView {
  return {
    key,
    provider: "anthropic",
    label: key,
    email: null,
    plan: null,
    identified: true,
    logins: [],
    sharedTokenKinds: [],
    usedBy: usedBy.map((agentId) => ({ agentId, scope: "global" })),
    usage: undefined,
    primary: undefined,
    primaryPercent: percent,
  };
}

function provider(accounts: AccountView[]): ProviderView {
  const harness = { agentId: "claude", name: "Claude Code" } as HarnessView;
  return {
    provider: "anthropic",
    title: "Anthropic",
    iconPath: null,
    pluginDir: null,
    dashboardUrl: null,
    legacy: false,
    primaryLimitId: null,
    harnesses: [harness],
    accounts,
    worstPercent: null,
  };
}

describe("providerSummary", () => {
  it("leads with the in-use account closest to its limit", () => {
    const summary = providerSummary(
      provider([
        account("work", 20, ["claude"]),
        account("home", 90, ["codex"]),
        account("spare", 99),
      ]),
    );
    expect(summary.lead?.key).toBe("home");
    expect(summary.caption).toBe("2 accounts in use");
  });

  it("ranks an account with no reading below one at zero", () => {
    const summary = providerSummary(provider([account("unknown", null), account("idle", 0)]));
    expect(summary.lead?.key).toBe("idle");
    expect(summary.caption).toBe("idle");
  });

  it("has nothing to say for a provider with no accounts", () => {
    expect(providerSummary(provider([]))).toEqual({ lead: undefined, caption: null });
  });
});

describe("usageStatusMessage", () => {
  it("passes the provider's reason through and never claims zero usage", () => {
    expect(
      usageStatusMessage({
        status: "unavailable",
        reason: "authentication-required",
        message: "Sign in",
      }),
    ).toBe("Sign in");
    expect(usageStatusMessage(undefined)).toBe("No usage data yet");
  });
});

describe("accountUsers", () => {
  it("names the harnesses it knows and skips the rest", () => {
    const work = account("work", 10, ["claude", "gone"]);
    expect(accountUsers(work, provider([work]))).toEqual(["Claude Code"]);
  });
});

describe("currentAccountLabel", () => {
  it("names the bound account, or the harness's own sign-in", () => {
    const work = account("work", 10);
    const bound = { agentId: "claude", current: { accountKey: "work" } } as HarnessView;
    const unbound = { agentId: "claude", current: undefined } as HarnessView;
    expect(currentAccountLabel(provider([work]), bound)).toBe("work");
    expect(currentAccountLabel(provider([work]), unbound)).toBe("Own sign-in");
  });
});
