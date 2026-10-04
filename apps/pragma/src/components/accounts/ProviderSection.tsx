import type { AccountsListResult } from "@pragma-sh/constants";
import { ArrowUpRight } from "lucide-react";

import { AccountRow } from "@/components/accounts/AccountRow";
import {
  HarnessAccountSelect,
  OverrideDot,
  type HarnessAccountActions,
} from "@/components/accounts/HarnessAccountSelect";
import { ProviderIcon, providerIconSrc } from "@/components/accounts/ProviderIcon";
import { Button } from "@/components/ui/button";
import {
  chipHarnesses,
  staleSessionCount,
  unassignedHarnesses,
  type HarnessView,
  type ProviderView,
} from "@pragma-sh/accounts-view";
import { browserOpenExternal } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * The toolbar menu's provider card: its accounts, then a row per harness with
 * the account it launches with. The menu lists only providers in use, so there
 * is always an account; Settings lays the same pieces out at page width.
 */
export function ProviderSection({
  actions,
  isRemote,
  list,
  provider,
}: {
  actions: HarnessAccountActions;
  isRemote: boolean;
  list: AccountsListResult;
  provider: ProviderView;
}) {
  return (
    <section className="flex flex-col gap-1 rounded-lg border bg-card p-1 shadow-xs">
      <header className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        <ProviderIcon
          className="size-3.5"
          src={providerIconSrc(provider.iconPath, provider.pluginDir, isRemote)}
        />
        <span className="truncate">{provider.title}</span>
        {provider.legacy ? <LegacyBadge /> : null}
        <span className="flex-1" />
        <DashboardLink provider={provider} />
      </header>
      {provider.accounts.map((account) => (
        <AccountRow account={account} key={account.key} />
      ))}
      <HarnessRows
        actions={actions}
        harnesses={provider.harnesses}
        list={list}
        provider={provider}
        size="sm"
      />
    </section>
  );
}

/** "legacy": a plugin too old to sign in from Pragma. */
export function LegacyBadge() {
  return (
    <span className="rounded border px-1 text-[10px] font-normal tracking-normal text-muted-foreground normal-case">
      legacy
    </span>
  );
}

/** Opens the provider's usage dashboard, when it declares one. */
export function DashboardLink({
  className,
  provider,
}: {
  className?: string;
  provider: ProviderView;
}) {
  const url = provider.dashboardUrl;
  if (!url) return null;
  return (
    <button
      aria-label={`${provider.title} dashboard`}
      className={cn(
        "inline-flex items-center gap-0.5 font-normal tracking-normal text-muted-foreground normal-case hover:text-foreground",
        className,
      )}
      onClick={() => void browserOpenExternal(url)}
      type="button"
    >
      Dashboard
      <ArrowUpRight className="size-3" />
    </button>
  );
}

/** A provider with no account yet: why, and a sign-in when a harness offers one. */
export function NoAccounts({
  onSignIn,
  provider,
}: {
  onSignIn: (() => void) | null;
  provider: ProviderView;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-4 py-3 text-sm">
      <span className="text-muted-foreground">
        {onSignIn
          ? "No account signed in"
          : provider.legacy
            ? "Update the plugin to sign in from Pragma"
            : "Sign in from the harness"}
      </span>
      {onSignIn ? (
        <Button onClick={onSignIn} size="sm" variant="outline">
          Sign in
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One row per harness that can use the provider: its name, and a select for
 * the account it launches with. `md` is Settings' bordered list.
 */
export function HarnessRows({
  actions,
  harnesses,
  list,
  provider,
  size,
}: {
  actions: HarnessAccountActions;
  harnesses: HarnessView[];
  list: AccountsListResult;
  provider: ProviderView;
  size: "sm" | "md";
}) {
  const unassigned = new Set(
    unassignedHarnesses({ ...provider, harnesses }).map((harness) => harness.agentId),
  );
  return (
    <ul
      className={cn(
        "flex flex-col",
        size === "md" ? "divide-y rounded-lg border" : "mt-0.5 border-t pt-1",
      )}
    >
      {chipHarnesses(provider, harnesses).map((harness) => (
        <li
          className={cn(
            "flex items-center gap-3",
            size === "md" ? "px-4 py-2.5" : "py-0.5 pr-0.5 pl-2",
          )}
          key={harness.agentId}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5",
                size === "md" ? "text-sm" : "text-[11px] text-muted-foreground",
              )}
            >
              <span className="truncate">{harness.name}</span>
              {harness.current?.scope === "project" ? <OverrideDot /> : null}
            </span>
            <StaleSessions harness={harness} list={list} provider={provider} />
          </span>
          <HarnessAccountSelect
            actions={actions}
            harness={harness}
            muted={unassigned.has(harness.agentId)}
            provider={provider}
            size={size}
          />
        </li>
      ))}
    </ul>
  );
}

function StaleSessions({
  harness,
  list,
  provider,
}: {
  harness: HarnessView;
  list: AccountsListResult;
  provider: ProviderView;
}) {
  // A harness that swaps a shared credential file has no session left behind:
  // running sessions read the file and follow the switch.
  if (harness.source.swaps) return null;
  const accountKey = harness.current?.accountKey;
  if (!accountKey || !provider.accounts.some((account) => account.key === accountKey)) return null;
  const stale = staleSessionCount(list, harness.agentId, provider.provider, accountKey);
  if (stale === 0) return null;
  return (
    <span className="truncate text-[10px] text-muted-foreground">
      {stale === 1 ? "1 running session" : `${stale} running sessions`} still on another account
    </span>
  );
}
