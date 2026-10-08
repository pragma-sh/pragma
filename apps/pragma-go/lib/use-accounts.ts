import {
  buildProviderViews,
  ProjectAccounts,
  type AccountsState,
  type HarnessView,
  type ProviderView,
} from "@pragma-sh/accounts-view";
import type { AgentIcon, PragmaClient } from "@pragma-sh/sdk";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { AppState } from "react-native";

import { useConnection } from "./connection-context";
import { useCatalog } from "./use-catalog";

/** The paired host's account providers, ready to render and switch. */
export interface Accounts {
  /** Providers with at least one account, in-use accounts first. */
  providers: ProviderView[];
  /** No list has arrived yet, so it is not known whether any provider exists. */
  loading: boolean;
  /** The last list read failed; previous providers, if any, are still shown. */
  error: string | null;
  /** Re-reads bindings and forces a usage load for every account. */
  refresh: () => Promise<void>;
  /** Points a harness at one of its provider's accounts, for every project. */
  switchAccount: (harness: HarnessView, accountKey: string) => Promise<void>;
  /** The catalog icon for a harness, for want of a provider icon the phone can load. */
  agentIcon: (agentId: string) => AgentIcon | null;
}

const EMPTY: AccountsState = { list: null, usage: new Map(), loading: true, error: null };

/**
 * One store per paired client. The store is the desktop's own (shared through
 * `@pragma-sh/accounts-view`), so the phone schedules usage with the same
 * per-account cadence and backoff, and validates readings the same way.
 */
const stores = new WeakMap<PragmaClient, ProjectAccounts>();

function storeFor(client: PragmaClient): ProjectAccounts {
  let store = stores.get(client);
  if (!store) {
    store = new ProjectAccounts(client.accounts);
    stores.set(client, store);
  }
  return store;
}

/**
 * Reads the host's accounts for the global scope — the home screen has no
 * project in view, so the bindings shown and written are the "all projects"
 * ones.
 *
 * The store polls only while subscribed, and this subscribes only while the
 * screen is focused *and* the app is in the foreground: a backgrounded phone
 * never runs the usage timer.
 */
export function useAccounts(): Accounts {
  const { client } = useConnection();
  const catalog = useCatalog();
  const store = useMemo(() => (client ? storeFor(client) : null), [client]);
  const [state, setState] = useState<AccountsState>(() => store?.getSnapshot() ?? EMPTY);

  useFocusEffect(
    useCallback(() => {
      if (!store) {
        setState(EMPTY);
        return undefined;
      }
      let unsubscribe: (() => void) | undefined;
      const stop = (): void => {
        unsubscribe?.();
        unsubscribe = undefined;
      };
      const start = (): void => {
        if (unsubscribe) return;
        setState(store.getSnapshot());
        unsubscribe = store.subscribe(() => setState(store.getSnapshot()));
        store.refreshUsageNow();
      };
      if (AppState.currentState === "active") start();
      const subscription = AppState.addEventListener("change", (next) => {
        if (next === "active") start();
        else stop();
      });
      return () => {
        stop();
        subscription.remove();
      };
    }, [store]),
  );

  const agentName = useCallback(
    (agentId: string) => catalog?.agents.find((agent) => agent.id === agentId)?.name ?? agentId,
    [catalog],
  );
  const agentIcon = useCallback(
    (agentId: string) => catalog?.agents.find((agent) => agent.id === agentId)?.icon ?? null,
    [catalog],
  );
  const providers = useMemo(
    () =>
      state.list
        ? buildProviderViews({ list: state.list, usage: state.usage }, agentName).filter(
            (provider) => provider.accounts.length > 0,
          )
        : [],
    [agentName, state.list, state.usage],
  );

  const refresh = useCallback(async () => {
    if (!store) return;
    store.refreshUsageNow();
    await store.reload();
  }, [store]);

  const switchAccount = useCallback(
    async (harness: HarnessView, accountKey: string) => {
      if (!store) return;
      await store.setBinding({
        agentId: harness.agentId,
        provider: harness.source.provider,
        accountKey,
        scope: "global",
      });
    },
    [store],
  );

  return {
    providers,
    loading: state.loading,
    error: state.error,
    refresh,
    switchAccount,
    agentIcon,
  };
}
