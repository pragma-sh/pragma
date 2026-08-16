import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let collapsed = new Set<string>();

/** Returns whether a worktree row is currently collapsed in the sidebar. */
export function isWorktreeCollapsed(worktreeId: string): boolean {
  return collapsed.has(worktreeId);
}

/** Toggles a worktree row's collapsed state. */
export function toggleWorktreeCollapsed(worktreeId: string): void {
  collapsed = new Set(collapsed);
  if (collapsed.has(worktreeId)) {
    collapsed.delete(worktreeId);
  } else {
    collapsed.add(worktreeId);
  }
  for (const listener of listeners) {
    listener();
  }
}

/** React hook for the current set of collapsed worktree ids, shared across
 *  every row so sidebar-order computation can see collapse state too. */
export function useCollapsedWorktreeIds(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => collapsed,
    () => new Set(),
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
