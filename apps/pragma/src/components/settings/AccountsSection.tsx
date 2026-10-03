import { useMemo, useState, type ReactNode } from "react";

import type { AccountsListResult } from "@pragma-sh/constants";
import { Plus } from "lucide-react";

import { AccountLogins, AccountName } from "@/components/accounts/AccountManagement";
import { rowActions, useProviderViews } from "@/components/accounts/AccountProvidersMenu";
import { AccountCard } from "@/components/accounts/AccountRow";
import { AddAccountDialog, type AddAccountTarget } from "@/components/accounts/AddAccountDialog";
import type { HarnessAccountActions } from "@/components/accounts/HarnessAccountSelect";
import { ProviderIcon, providerIconSrc } from "@/components/accounts/ProviderIcon";
import {
  DashboardLink,
  HarnessRows,
  LegacyBadge,
  NoAccounts,
} from "@/components/accounts/ProviderSection";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { Button } from "@/components/ui/button";
import { globalHarnessView, shownProviders, type ProviderView } from "@/lib/accounts";
import type { ConfigScope } from "@/lib/tauri";
import { useProjectAccounts, type ProjectAccounts } from "@/state/accounts-store";

/**
 * Settings › Account providers: a card per provider listing its accounts (each
 * with every limit, a rename, and its logins), then the account each harness
 * launches with in this page's scope.
 */
export function AccountsSection({
  isRemote,
  projectId,
  scope,
}: {
  isRemote: boolean;
  projectId: string | null;
  scope: ConfigScope;
}) {
  const { state, store } = useProjectAccounts(projectId);
  const providers = useProviderViews(state);
  const shown = useMemo(() => shownProviders(providers), [providers]);
  const canSignIn = providers.some((provider) =>
    provider.harnesses.some((harness) => harness.source.hasLogin),
  );
  const [addTarget, setAddTarget] = useState<AddAccountTarget | null>(null);
  const [adding, setAdding] = useState(false);
  const list = state.list;
  const startAdd = (target: AddAccountTarget | null) => {
    setAddTarget(target);
    setAdding(true);
  };
  const actions = rowActions(
    store,
    (harness) => startAdd({ provider: harness.source.provider, agentId: harness.agentId }),
    scope,
  );
  return (
    <div className="flex flex-col gap-6">
      <SettingsCard
        actions={
          canSignIn ? (
            <Button onClick={() => startAdd(null)} size="sm">
              <Plus />
              Add account
            </Button>
          ) : null
        }
        description={
          scope === "global"
            ? "Choose the account each harness uses in every project that has not chosen its own. Running sessions keep the account they started with."
            : "Accounts chosen here override the global choice for this project only. Running sessions keep the account they started with."
        }
        title="Account providers"
      >
        {sectionStatus(state.error, list, providers.length === 0)}
      </SettingsCard>
      {list
        ? shown.map((provider) => (
            <ProviderCard
              actions={actions}
              isRemote={isRemote}
              key={provider.provider}
              list={list}
              onSignIn={(agentId) => startAdd({ provider: provider.provider, agentId })}
              provider={provider}
              scope={scope}
              store={store}
            />
          ))
        : null}
      <AddAccountDialog
        isRemote={isRemote}
        onOpenChange={setAdding}
        open={adding}
        providers={providers}
        store={store}
        target={addTarget}
      />
    </div>
  );
}

/** Loading, error, or "no providers": the intro card's body, when there is one. */
function sectionStatus(
  error: string | null | undefined,
  list: AccountsListResult | null | undefined,
  empty: boolean,
): ReactNode {
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!list) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (empty) {
    return (
      <p className="text-sm text-muted-foreground">
        No installed agent plugin declares an account provider.
      </p>
    );
  }
  return null;
}

function ProviderCard({
  actions,
  isRemote,
  list,
  onSignIn,
  provider,
  scope,
  store,
}: {
  actions: HarnessAccountActions;
  isRemote: boolean;
  list: AccountsListResult;
  onSignIn: (agentId: string) => void;
  provider: ProviderView;
  scope: ConfigScope;
  store: ProjectAccounts;
}) {
  const harnesses =
    scope === "global"
      ? provider.harnesses.map((harness) => globalHarnessView(harness, provider, list))
      : provider.harnesses;
  const signInHarness = harnesses.find((harness) => harness.source.hasLogin);
  return (
    <SettingsCard
      actions={
        <>
          {provider.legacy ? <LegacyBadge /> : null}
          <DashboardLink className="text-xs" provider={provider} />
        </>
      }
      icon={<ProviderIcon src={providerIconSrc(provider.iconPath, provider.pluginDir, isRemote)} />}
      title={provider.title}
    >
      <div className="flex flex-col gap-6">
        <Group title="Accounts">
          {provider.accounts.length > 0 ? (
            <div className="divide-y rounded-lg border">
              {provider.accounts.map((account) => (
                <AccountCard
                  account={account}
                  footer={<AccountLogins account={account} provider={provider} store={store} />}
                  key={account.key}
                  name={<AccountName account={account} store={store} />}
                />
              ))}
            </div>
          ) : (
            <NoAccounts
              onSignIn={signInHarness ? () => onSignIn(signInHarness.agentId) : null}
              provider={provider}
            />
          )}
        </Group>
        {provider.accounts.length > 0 ? (
          <Group
            description={
              scope === "global"
                ? "The account each harness launches with."
                : "The account each harness launches with in this project."
            }
            title="Harnesses"
          >
            <HarnessRows
              actions={actions}
              harnesses={harnesses}
              list={list}
              provider={provider}
              size="md"
            />
          </Group>
        ) : null}
      </div>
    </SettingsCard>
  );
}

function Group({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}
