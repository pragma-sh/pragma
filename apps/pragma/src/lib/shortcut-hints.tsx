import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

export interface ShortcutHints {
  projects: Readonly<Record<number, string>>;
  worktrees: Readonly<Record<number, string>>;
  tabs: Readonly<Record<number, string>>;
}

export const emptyShortcutHints: ShortcutHints = { projects: {}, worktrees: {}, tabs: {} };

const ShortcutHintsContext = createContext<ShortcutHints>(emptyShortcutHints);
const WorktreeShortcutOrderContext = createContext<ReadonlyMap<string, number>>(new Map());
let worktreeShortcutOrder: readonly string[] = [];
const worktreeOrderListeners = new Set<() => void>();

/** Makes currently held navigation shortcut hints available to sidebar and tab chrome. */
export function ShortcutHintsProvider({
  hints,
  children,
}: {
  hints: ShortcutHints;
  children: ReactNode;
}) {
  return <ShortcutHintsContext.Provider value={hints}>{children}</ShortcutHintsContext.Provider>;
}

/** Returns the configured key to reveal for one numbered navigation target. */
export function useShortcutHint(
  target: "project" | "worktree" | "tab",
  index: number | null,
): string | null {
  const hints = useContext(ShortcutHintsContext);
  if (index === null) return null;
  if (target === "project") return hints.projects[index] ?? null;
  return (target === "worktree" ? hints.worktrees[index] : hints.tabs[index]) ?? null;
}

/** Supplies exact visual sidebar order to each worktree row and fanout member. */
export function WorktreeShortcutOrderProvider({
  worktreeIds,
  children,
}: {
  worktreeIds: readonly string[];
  children: ReactNode;
}) {
  const indices = useMemo(
    () => new Map(worktreeIds.map((id, index) => [id, index + 1])),
    [worktreeIds],
  );
  return (
    <WorktreeShortcutOrderContext.Provider value={indices}>
      {children}
    </WorktreeShortcutOrderContext.Provider>
  );
}

/** Returns one worktree's 1-based position in current sidebar ordering. */
export function useWorktreeShortcutIndex(worktreeId: string | null): number | null {
  const indices = useContext(WorktreeShortcutOrderContext);
  const index = worktreeId ? indices.get(worktreeId) : undefined;
  return index !== undefined && index <= 9 ? index : null;
}

/** Publishes current sidebar ordering for global shortcut dispatch. */
export function setWorktreeShortcutOrder(worktreeIds: readonly string[]): void {
  if (
    worktreeIds.length === worktreeShortcutOrder.length &&
    worktreeIds.every((id, index) => id === worktreeShortcutOrder[index])
  ) {
    return;
  }
  worktreeShortcutOrder = [...worktreeIds];
  for (const listener of worktreeOrderListeners) listener();
}

/** Subscribes global shortcut handling to current visual sidebar order. */
export function useWorktreeShortcutOrder(): readonly string[] {
  return useSyncExternalStore(
    (listener) => {
      worktreeOrderListeners.add(listener);
      return () => worktreeOrderListeners.delete(listener);
    },
    () => worktreeShortcutOrder,
  );
}
