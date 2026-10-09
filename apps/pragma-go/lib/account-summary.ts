import type { AccountView, HarnessView, ProviderView } from "@pragma-sh/accounts-view";
import type { UsageLimitsResult } from "@pragma-sh/constants";

/** What a collapsed provider card shows: one account, and a caption naming it. */
export interface ProviderSummary {
  /** The account that runs out first among those in use (or among all of them). */
  lead: AccountView | undefined;
  caption: string | null;
}

/**
 * Summarises a provider by the account that blocks you first, so the collapsed
 * card never hides an account that is about to run out.
 */
export function providerSummary(provider: ProviderView): ProviderSummary {
  const inUse = provider.accounts.filter((account) => account.usedBy.length > 0);
  const lead = closestToLimit(inUse.length > 0 ? inUse : provider.accounts);
  if (!lead) return { lead, caption: null };
  return { lead, caption: inUse.length > 1 ? `${inUse.length} accounts in use` : lead.label };
}

function closestToLimit(accounts: AccountView[]): AccountView | undefined {
  let worst: AccountView | undefined;
  for (const account of accounts) {
    if (!worst || usageRank(account) > usageRank(worst)) worst = account;
  }
  return worst;
}

/** An account with no reading ranks below one at 0%. */
function usageRank(account: AccountView): number {
  return account.primaryPercent ?? -1;
}

/** Why an account shows no bar: never phrased as zero usage. */
export function usageStatusMessage(result: UsageLimitsResult | undefined): string {
  return result?.status === "unavailable" ? result.message : "No usage data yet";
}

/** Names of the harnesses launching with an account, for its "Used by" line. */
export function accountUsers(account: AccountView, provider: ProviderView): string[] {
  return account.usedBy.flatMap((use) => {
    const harness = provider.harnesses.find((candidate) => candidate.agentId === use.agentId);
    return harness ? [harness.name] : [];
  });
}

/**
 * The account a harness launches with, by label. A harness with no binding
 * and no listed login falls back to its own sign-in, which Pragma does not see.
 */
export function currentAccountLabel(provider: ProviderView, harness: HarnessView): string {
  const key = harness.current?.accountKey;
  return provider.accounts.find((account) => account.key === key)?.label ?? "Own sign-in";
}
