import { useCallback, useSyncExternalStore } from "react";

interface Entry<T> {
  /** `null` until the first load settles. */
  items: T[] | null;
  loading: boolean;
  /** An invalidation arrived mid-load, so the result is already out of date. */
  stale: boolean;
  listeners: Set<() => void>;
}

function notify(entry: Entry<unknown>): void {
  for (const listener of entry.listeners) listener();
}

/** A keyed, shared cache of one list per worktree. */
export interface WorktreeListStore<T> {
  /** The worktree's list, or `null` before its first load settles. Loads on first use. */
  useList: (worktreeId: string) => T[] | null;
  /** Re-fetches a worktree's list if anything shows it, else drops it from the cache. */
  invalidate: (worktreeId: string) => void;
}

/** Options for {@link createWorktreeListStore}. */
export interface WorktreeListStoreOptions {
  /**
   * Re-fetch every read worktree this often (ms) while the window is visible,
   * and as soon as it regains focus. For lists whose source announces no
   * changes — e.g. host-database rows an agent or the CLI can write.
   */
  pollMs?: number;
}

/** Whether two loads hold the same items, so an unchanged poll re-renders nothing. */
function sameItems(previous: readonly unknown[] | null, next: readonly unknown[]): boolean {
  return previous !== null && JSON.stringify(previous) === JSON.stringify(next);
}

/**
 * Creates a per-worktree list cache, so every reader of one worktree's list (a
 * sidebar chip's count and the section body it expands) shares a single fetch.
 * A failed load reads as an empty list, so callers render nothing rather than
 * an error. Each worktree re-fetches when its first reader mounts and whenever
 * it is invalidated while read (or polled, with `pollMs`); an unread worktree
 * is simply forgotten.
 */
export function createWorktreeListStore<T>(
  load: (worktreeId: string) => Promise<T[]>,
  options: WorktreeListStoreOptions = {},
): WorktreeListStore<T> {
  const entries = new Map<string, Entry<T>>();
  const poller = options.pollMs === undefined ? null : createPoller(options.pollMs, refreshAll);

  function refreshAll(): void {
    for (const [worktreeId, entry] of entries) {
      if (entry.listeners.size > 0 && !entry.loading) void fetch(worktreeId, entry);
    }
  }

  async function fetch(worktreeId: string, entry: Entry<T>): Promise<void> {
    entry.loading = true;
    entry.stale = false;
    let items: T[];
    try {
      items = await load(worktreeId);
    } catch {
      items = [];
    }
    entry.loading = false;
    // A result invalidated mid-load is already out of date: fetch again, show nothing new.
    if (entry.stale && entry.listeners.size > 0) {
      void fetch(worktreeId, entry);
      return;
    }
    if (sameItems(entry.items, items)) return;
    entry.items = items;
    notify(entry);
  }

  function entryFor(worktreeId: string): Entry<T> {
    let entry = entries.get(worktreeId);
    if (!entry) {
      entry = { items: null, loading: false, stale: false, listeners: new Set() };
      entries.set(worktreeId, entry);
    }
    return entry;
  }

  function invalidate(worktreeId: string): void {
    const entry = entries.get(worktreeId);
    if (!entry) return;
    if (entry.listeners.size === 0) {
      entries.delete(worktreeId);
    } else if (entry.loading) {
      entry.stale = true;
    } else {
      void fetch(worktreeId, entry);
    }
  }

  function useList(worktreeId: string): T[] | null {
    const subscribe = useCallback(
      (listener: () => void) => {
        const entry = entryFor(worktreeId);
        const first = entry.listeners.size === 0;
        entry.listeners.add(listener);
        poller?.retain();
        // The first reader refreshes a cached list: nothing was watching it for changes.
        if (first && !entry.loading) void fetch(worktreeId, entry);
        return () => {
          entry.listeners.delete(listener);
          poller?.release();
        };
      },
      [worktreeId],
    );
    return useSyncExternalStore(
      subscribe,
      () => entries.get(worktreeId)?.items ?? null,
      () => null,
    );
  }

  return { useList, invalidate };
}

/** A ref-counted timer: runs `tick` on an interval while held and the window is visible. */
function createPoller(
  intervalMs: number,
  tick: () => void,
): { retain: () => void; release: () => void } {
  let holders = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const onVisible = (): void => {
    if (document.visibilityState === "visible") tick();
  };
  return {
    retain() {
      holders += 1;
      if (holders > 1) return;
      timer = setInterval(onVisible, intervalMs);
      window.addEventListener("focus", onVisible);
      document.addEventListener("visibilitychange", onVisible);
    },
    release() {
      holders -= 1;
      if (holders > 0) return;
      clearInterval(timer);
      timer = undefined;
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
