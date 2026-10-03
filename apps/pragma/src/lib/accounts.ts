import type {
  AccountBindingScope,
  AccountEffectiveBinding,
  AccountLogin,
  AccountProviderInfo,
  AccountsListResult,
} from "@pragma-sh/constants";
import type { UsageLimit, UsageLimitsResult } from "@pragma-sh/plugin";

import { percentUsed, primaryLimit } from "@/lib/usage-limits";

/** One harness that can use a provider, and the account it uses right now. */
export interface HarnessView {
  agentId: string;
  name: string;
  /** The declaring plugin's provider entry (login command, multi-account). */
  source: AccountProviderInfo;
  current: AccountEffectiveBinding | undefined;
}

/** One account: every login of one provider that reports the same identity. */
export interface AccountView {
  key: string;
  provider: string;
  label: string;
  email: string | null;
  plan: string | null;
  /** False for a login that cannot report who it is (legacy or signed out). */
  identified: boolean;
  logins: AccountLogin[];
  /** Token kinds its logins can share (see `AccountProviderInfo.sharedTokenKind`). */
  sharedTokenKinds: string[];
  /** Harnesses currently launching with this account, and why. */
  usedBy: Array<{ agentId: string; scope: AccountBindingScope | null }>;
  usage: UsageLimitsResult | undefined;
  primary: UsageLimit | undefined;
  primaryPercent: number | null;
}

/** One provider row group in the Account providers menu. */
export interface ProviderView {
  provider: string;
  title: string;
  iconPath: string | null;
  pluginDir: string | null;
  dashboardUrl: string | null;
  legacy: boolean;
  primaryLimitId: string | null;
  harnesses: HarnessView[];
  accounts: AccountView[];
  /** Highest primary usage among accounts in use: the one that blocks you first. */
  worstPercent: number | null;
}

/** Everything needed to derive the menu, as the host reported it. */
export interface AccountsSnapshot {
  list: AccountsListResult;
  usage: ReadonlyMap<string, UsageLimitsResult>;
}

/** Groups the host's logins into provider -> account views. */
export function buildProviderViews(
  snapshot: AccountsSnapshot,
  agentName: (agentId: string) => string,
): ProviderView[] {
  const { list, usage } = snapshot;
  const byProvider = new Map<string, AccountProviderInfo[]>();
  for (const info of list.providers) {
    byProvider.set(info.provider, [...(byProvider.get(info.provider) ?? []), info]);
  }
  return [...byProvider.entries()].map(([provider, infos]) => {
    const first = infos[0]!;
    const harnesses = harnessViews(provider, infos, list.effective, agentName);
    const accounts = accountViews(
      provider,
      infos,
      list,
      usage,
      harnesses,
      first.primaryLimitId,
      agentName,
    );
    return {
      provider,
      title: first.title,
      iconPath: infos.find((info) => info.iconPath)?.iconPath ?? null,
      pluginDir: infos.find((info) => info.iconPath)?.pluginDir ?? first.pluginDir,
      dashboardUrl: infos.find((info) => info.dashboardUrl)?.dashboardUrl ?? null,
      legacy: infos.every((info) => info.legacy),
      primaryLimitId: first.primaryLimitId,
      harnesses,
      accounts,
      worstPercent: worstPercent(accounts),
    };
  });
}

/**
 * Providers worth a section: those with an account, plus those a harness can
 * hold several accounts of. A multi-provider harness (OpenCode, Pi) declares
 * every provider it can hold a key for; the ones it is not signed in to stay
 * out of the way until it is, and remain reachable from Add account.
 */
export function shownProviders(providers: ProviderView[]): ProviderView[] {
  return providers.filter(
    (provider) =>
      provider.accounts.length > 0 ||
      provider.harnesses.some((harness) => harness.source.multiAccount),
  );
}

/**
 * Providers a harness launches with right now: at least one account in use.
 * The toolbar menu shows only these; Settings and Add account show the rest.
 */
export function inUseProviders(providers: ProviderView[]): ProviderView[] {
  return providers.filter((provider) =>
    provider.accounts.some((account) => account.usedBy.length > 0),
  );
}

/** The harness's login for an account, if it has signed in to it. */
function harnessLogin(account: AccountView, agentId: string): AccountLogin | undefined {
  return account.logins.find((login) => login.agentId === agentId);
}

/** What it takes for a harness to use one account of its provider. */
export type HarnessAccountChoice =
  /** Usable now: the harness's own login, or one it can borrow. */
  | { account: AccountView; status: "ready"; borrowed: boolean }
  /** The harness needs its own sign-in to this account first. */
  | { account: AccountView; status: "signIn" }
  /** The harness cannot use this account; `reason` says why. */
  | { account: AccountView; status: "unavailable"; reason: string };

/**
 * Every account of the provider as `harness` sees it, so its dropdown lists
 * them all: usable ones first, then ones it would have to sign in to, then
 * ones it cannot use, with the reason.
 */
export function harnessAccountChoices(
  provider: ProviderView,
  harness: HarnessView,
): HarnessAccountChoice[] {
  const order = { ready: 0, signIn: 1, unavailable: 2 } as const;
  return provider.accounts
    .map((account) => accountChoice(account, harness, provider.title))
    .toSorted((a, b) => order[a.status] - order[b.status]);
}

/**
 * The harnesses worth a row under a provider: those already on one of its
 * accounts, or able to use or sign in to one. A harness that takes only an API
 * key (OpenCode or Kimi Code under Anthropic, where a Claude subscription may
 * only be used in Claude Code) has no row while the provider lists none — it
 * would be a select whose every option is disabled. Add account still offers it.
 */
export function chipHarnesses(provider: ProviderView, harnesses: HarnessView[]): HarnessView[] {
  const keys = new Set(provider.accounts.map((account) => account.key));
  return harnesses.filter(
    (harness) =>
      keys.has(harness.current?.accountKey ?? "") ||
      harnessAccountChoices(provider, harness).some((choice) => choice.status !== "unavailable"),
  );
}

function accountChoice(
  account: AccountView,
  harness: HarnessView,
  providerTitle: string,
): HarnessAccountChoice {
  if (harnessLogin(account, harness.agentId) !== undefined) {
    return { account, status: "ready", borrowed: false };
  }
  if (borrowsSignIn(account, harness)) return { account, status: "ready", borrowed: true };
  const keysOnly = harness.source.sharedTokenKind?.startsWith("key:") ?? false;
  if (keysOnly && !isApiKeyAccount(account)) {
    return {
      account,
      status: "unavailable",
      reason: `${harness.name} can only use an API key for ${providerTitle}`,
    };
  }
  if (canSignInAnother(harness)) return { account, status: "signIn" };
  return {
    account,
    status: "unavailable",
    reason: `Sign in to it inside ${harness.name}`,
  };
}

/** An account identified by an API key's digest rather than a sign-in. */
function isApiKeyAccount(account: AccountView): boolean {
  return account.logins.some((login) => login.identity?.id.startsWith("key:"));
}

/**
 * Whether picking `account` for `harness` reuses another harness's sign-in:
 * the harness has no login for it, but can share one of the same token kind.
 */
function borrowsSignIn(account: AccountView, harness: HarnessView): boolean {
  const kind = harness.source.sharedTokenKind;
  return (
    !!kind &&
    !!harness.source.sharedTokenWritable &&
    harnessLogin(account, harness.agentId) === undefined &&
    account.sharedTokenKinds.includes(kind)
  );
}

/** How the menu describes a borrowed sign-in: an API key, or an account sign-in. */
export function borrowedSignInLabel(harness: HarnessView): string {
  return harness.source.sharedTokenKind?.startsWith("key:")
    ? "Uses its existing API key"
    : "Uses its existing sign-in";
}

/** Whether a harness can sign in to another account of its provider from Pragma. */
export function canSignInAnother(harness: HarnessView): boolean {
  return harness.source.hasLogin && harness.source.multiAccount;
}

/** Harnesses of a provider not on any of its listed accounts (own login, or unbound). */
export function unassignedHarnesses(provider: ProviderView): HarnessView[] {
  const keys = new Set(provider.accounts.map((account) => account.key));
  return provider.harnesses.filter((harness) => {
    const key = harness.current?.accountKey;
    return !key || !keys.has(key);
  });
}

/** Live sessions of a harness still running on a different account than `accountKey`. */
export function staleSessionCount(
  list: AccountsListResult,
  agentId: string,
  provider: string,
  accountKey: string,
): number {
  return list.sessions.filter(
    (use) => use.agentId === agentId && use.provider === provider && use.accountKey !== accountKey,
  ).length;
}

/**
 * Scope a hover switch writes. A switch is global ("all projects") unless this
 * project already overrides the harness, in which case the override is updated.
 */
export function switchScope(harness: HarnessView | undefined): AccountBindingScope {
  return harness?.current?.scope === "project" ? "project" : "global";
}

/**
 * The harness as Settings' global scope sees it: its global choice, or else
 * the account of its own default login — never this project's override.
 */
export function globalHarnessView(
  harness: HarnessView,
  provider: ProviderView,
  list: AccountsListResult,
): HarnessView {
  // Without a project override the effective binding already is the global one.
  if (harness.current?.scope !== "project") return harness;
  const globalKey = list.state.bindings.global[harness.agentId]?.[provider.provider];
  const ownLogin = provider.accounts.find((account) =>
    account.logins.some((login) => login.agentId === harness.agentId && login.home === null),
  );
  return {
    ...harness,
    current: {
      agentId: harness.agentId,
      provider: provider.provider,
      accountKey: globalKey ?? ownLogin?.key ?? null,
      loginId: null,
      scope: globalKey ? "global" : null,
    },
  };
}

function harnessViews(
  provider: string,
  infos: AccountProviderInfo[],
  effective: AccountEffectiveBinding[],
  agentName: (agentId: string) => string,
): HarnessView[] {
  const harnesses: HarnessView[] = [];
  for (const info of infos) {
    for (const agentId of info.agentIds) {
      if (harnesses.some((harness) => harness.agentId === agentId)) continue;
      harnesses.push({
        agentId,
        name: agentName(agentId),
        source: info,
        current: effective.find(
          (entry) => entry.agentId === agentId && entry.provider === provider,
        ),
      });
    }
  }
  return harnesses;
}

function accountViews(
  provider: string,
  infos: AccountProviderInfo[],
  list: AccountsListResult,
  usage: ReadonlyMap<string, UsageLimitsResult>,
  harnesses: HarnessView[],
  primaryLimitId: string | null,
  agentName: (agentId: string) => string,
): AccountView[] {
  const groups = new Map<string, AccountLogin[]>();
  for (const login of list.state.logins) {
    if (login.provider !== provider || isSignedOut(login, infos)) continue;
    const key = list.loginKeys[login.id] ?? `login:${login.id}`;
    groups.set(key, [...(groups.get(key) ?? []), login]);
  }
  const accounts = [...groups.entries()].map(([key, logins]): AccountView => {
    const identity = logins.find((login) => login.identity)?.identity ?? null;
    const result = usage.get(key);
    const primary = primaryLimit(result, primaryLimitId);
    return {
      key,
      provider,
      label: list.state.labels[key] ?? defaultLabel(identity, logins, agentName),
      email: identity?.email ?? null,
      plan: identity?.plan ?? null,
      identified: identity !== null,
      logins,
      sharedTokenKinds: sharedTokenKinds(logins, infos, list.providers),
      usedBy: harnesses
        .filter((harness) => harness.current?.accountKey === key)
        .map((harness) => ({ agentId: harness.agentId, scope: harness.current?.scope ?? null })),
      usage: result,
      primary,
      primaryPercent: primary ? percentUsed(primary) : null,
    };
  });
  // Accounts in use first, then by label, so the row order is stable.
  return accounts.toSorted(
    (a, b) =>
      Number(b.usedBy.length > 0) - Number(a.usedBy.length > 0) || a.label.localeCompare(b.label),
  );
}

/** Token kinds of the providers behind `logins`, from this provider's or any listed infos. */
function sharedTokenKinds(
  logins: AccountLogin[],
  infos: AccountProviderInfo[],
  all: AccountProviderInfo[],
): string[] {
  const kinds = new Set<string>();
  for (const login of logins) {
    const info = [...infos, ...all].find(
      (candidate) =>
        candidate.pluginId === login.pluginId && candidate.providerId === login.providerId,
    );
    if (info?.sharedTokenKind) kinds.add(info.sharedTokenKind);
  }
  return [...kinds];
}

/**
 * A harness's own default login that its plugin could not identify: nobody is
 * signed in there. A provider without `identify` (legacy, or one that cannot
 * tell) keeps its default login, the only account it has.
 */
function isSignedOut(login: AccountLogin, infos: AccountProviderInfo[]): boolean {
  if (login.home !== null || login.identity !== null) return false;
  return infos.some(
    (info) =>
      info.pluginId === login.pluginId && info.providerId === login.providerId && info.identifies,
  );
}

function defaultLabel(
  identity: AccountLogin["identity"],
  logins: AccountLogin[],
  agentName: (agentId: string) => string,
): string {
  if (identity) return identity.email ?? identity.name ?? identity.id;
  const login = logins[0];
  if (!login) return "Account";
  return login.home === null ? `Default · ${agentName(login.agentId)}` : "Unidentified account";
}

function worstPercent(accounts: AccountView[]): number | null {
  const inUse = accounts.filter((account) => account.usedBy.length > 0);
  const pool = inUse.length > 0 ? inUse : accounts;
  const percents = pool
    .map((account) => account.primaryPercent)
    .filter((percent): percent is number => percent !== null);
  return percents.length > 0 ? Math.max(...percents) : null;
}
