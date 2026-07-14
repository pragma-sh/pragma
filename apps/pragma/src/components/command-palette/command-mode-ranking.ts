import type { Worktree } from "@pragma/constants";

function worktreeLabel(worktree: Worktree): string {
  return worktree.title || worktree.branch;
}

/** Filters worktrees by query and orders them from most to least recently opened. */
export function rankEditorWorktrees(
  worktrees: Worktree[],
  query: string,
  recencyByWorktree: Record<string, number>,
): Worktree[] {
  const normalized = query.trim().toLocaleLowerCase();
  return worktrees
    .filter(
      (worktree) =>
        normalized.length === 0 ||
        worktreeLabel(worktree).toLocaleLowerCase().includes(normalized) ||
        worktree.branch.toLocaleLowerCase().includes(normalized),
    )
    .toSorted(
      (left, right) =>
        (recencyByWorktree[right.id] ?? 0) - (recencyByWorktree[left.id] ?? 0) ||
        worktreeLabel(left).localeCompare(worktreeLabel(right)),
    );
}
