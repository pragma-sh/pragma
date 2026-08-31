import { useSyncExternalStore } from "react";

/**
 * Ephemeral per-editor-tab dirty state and latest document text.
 *
 * This is a module-level store (mirroring `lib/native-overlay.ts`) read through
 * `useSyncExternalStore`. It is intentionally **never** in the workspace reducer
 * and **never** persisted: an editor tab's saved-vs-unsaved status is transient
 * UI state, recomputed each session from the on-disk file. The latest-doc map
 * lets the close-confirmation dialog save without reaching into the editor view.
 */
const dirty = new Map<string, boolean>();
const docs = new Map<string, string>();
const savedDocs = new Map<string, string>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/** Marks a tab dirty/clean; only notifies subscribers when the value changes. */
export function setTabDirty(tabId: string, value: boolean): void {
  const current = dirty.get(tabId) ?? false;
  if (current === value) {
    return;
  }
  if (value) {
    dirty.set(tabId, true);
  } else {
    dirty.delete(tabId);
  }
  emit();
}

/** Whether a tab currently has unsaved edits. */
export function isTabDirty(tabId: string): boolean {
  return dirty.get(tabId) ?? false;
}

/** Records the latest editor document for a tab (used by close-on-save). */
export function setTabDoc(tabId: string, doc: string): void {
  docs.set(tabId, doc);
}

/** Reads the latest recorded editor document for a tab, if any. */
export function getTabDoc(tabId: string): string | null {
  return docs.get(tabId) ?? null;
}

/** Records the on-disk baseline used to restore dirty editors after a remount. */
export function setTabSavedDoc(tabId: string, doc: string): void {
  savedDocs.set(tabId, doc);
}

/** Reads the saved baseline for a preserved editor document, if any. */
export function getTabSavedDoc(tabId: string): string | null {
  return savedDocs.get(tabId) ?? null;
}

/** Drops all transient state for a tab after its close is confirmed. */
export function disposeTab(tabId: string): void {
  docs.delete(tabId);
  savedDocs.delete(tabId);
  setTabDirty(tabId, false);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribes a component to one tab's dirty flag. */
export function useTabDirty(tabId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isTabDirty(tabId),
    () => isTabDirty(tabId),
  );
}
