import { createToggleSetStore } from "@/lib/external-set-store";

/**
 * Persisted on/off preferences for the project sidebar's layout. Cosmetic,
 * per-device state, so it lives in `localStorage` like worktree pins.
 */
const store = createToggleSetStore("pragma.sidebarPreferences");

/** Worktree rows show only their title line, the original compact layout. */
const COMPACT_ROWS = "compactRows";

/** Whether worktree rows are compact (title only) rather than detailed. */
export function useCompactWorktreeRows(): boolean {
  return store.useSnapshot().has(COMPACT_ROWS);
}

/** Switches worktree rows between compact and detailed. */
export function setCompactWorktreeRows(compact: boolean): void {
  store.set(COMPACT_ROWS, compact);
}
