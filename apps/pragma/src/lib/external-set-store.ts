import { useSyncExternalStore } from "react";

/** A toggled string-id set backed by React's external-store API, optionally
 *  persisted to `localStorage`. Shared scaffolding for sidebar/menu state
 *  (pins, collapse) that only needs "is this id in the set" + "toggle it". */
export function createToggleSetStore(storageKey?: string) {
  const listeners = new Set<() => void>();
  let values = readInitial();

  function toggle(id: string): void {
    values = new Set(values);
    if (values.has(id)) {
      values.delete(id);
    } else {
      values.add(id);
    }
    writeValues(values);
    for (const listener of listeners) {
      listener();
    }
  }

  function useSnapshot(): ReadonlySet<string> {
    return useSyncExternalStore(
      subscribe,
      () => values,
      () => new Set<string>(),
    );
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function readInitial(): Set<string> {
    if (!storageKey) return new Set();
    try {
      const raw = localStorage.getItem(storageKey);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  }

  function writeValues(value: Set<string>): void {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify([...value]));
    } catch {
      // Cosmetic state; ignore unavailable storage.
    }
  }

  return { toggle, has: (id: string) => values.has(id), useSnapshot };
}
