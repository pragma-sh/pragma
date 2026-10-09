import { useEffect, useSyncExternalStore } from "react";

import { ProjectAccounts, type AccountsState } from "@pragma-sh/accounts-view";

import type { AccountsSnapshot } from "@pragma-sh/accounts-view";
import { accountsApi } from "@/lib/tauri";

const stores = new Map<string, ProjectAccounts>();

/** The shared accounts store for a project's host (`null`: this machine). */
function projectAccounts(projectId: string | null): ProjectAccounts {
  const key = projectId ?? "";
  let store = stores.get(key);
  if (!store) {
    store = new ProjectAccounts(accountsApi(projectId));
    stores.set(key, store);
  }
  return store;
}

/**
 * The project's accounts and cached usage, for a one-off read outside React
 * (auto mode). When nothing has loaded the account list yet it is loaded, for
 * at most `waitMs`; usage is never awaited — a provider CLI can take seconds,
 * and accounts whose usage has not arrived are simply reported as unknown.
 */
export async function projectAccountsSnapshot(
  projectId: string | null,
  waitMs: number,
): Promise<AccountsSnapshot | null> {
  const store = projectAccounts(projectId);
  if (store.getSnapshot().list === null) {
    await Promise.race([store.reload(), new Promise((resolve) => setTimeout(resolve, waitMs))]);
  }
  const { list, usage } = store.getSnapshot();
  return list ? { list, usage } : null;
}

/** Subscribes to a project's accounts; polling runs while anything subscribes. */
export function useProjectAccounts(projectId: string | null): {
  state: AccountsState;
  store: ProjectAccounts;
} {
  const store = projectAccounts(projectId);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // A new project opens on its host's current state, not the previous one's.
  useEffect(() => {
    if (store.getSnapshot().list === null) return;
    void store.reload();
  }, [store]);
  return { state, store };
}
