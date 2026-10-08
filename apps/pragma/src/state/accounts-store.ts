import { useEffect, useSyncExternalStore } from "react";

import { ProjectAccounts, type AccountsState } from "@pragma-sh/accounts-view";

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
