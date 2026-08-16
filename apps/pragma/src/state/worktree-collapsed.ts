import { createToggleSetStore } from "@/lib/external-set-store";

const store = createToggleSetStore();

/** Toggles a worktree row's collapsed state. */
export function toggleWorktreeCollapsed(worktreeId: string): void {
  store.toggle(worktreeId);
}

/** React hook for the current set of collapsed worktree ids, shared across
 *  every row so sidebar-order computation can see collapse state too. */
export function useCollapsedWorktreeIds(): ReadonlySet<string> {
  return store.useSnapshot();
}
