import type { Worktree } from "@pragma/constants";

export interface WorktreeNode {
  worktree: Worktree;
  children: WorktreeNode[];
}

export function buildTree(worktrees: Worktree[]): WorktreeNode[] {
  const roots: WorktreeNode[] = [];
  const map = new Map<string, WorktreeNode>();

  worktrees.sort((a, b) => {
    if (a.isMain !== b.isMain) return b.isMain - a.isMain;
    return a.createdAt.localeCompare(b.createdAt);
  });

  for (const wt of worktrees) {
    const node: WorktreeNode = { worktree: wt, children: [] };
    map.set(wt.id, node);
  }

  for (const wt of worktrees) {
    const node = map.get(wt.id);
    if (!node) continue;

    if (wt.parentId) {
      const parent = map.get(wt.parentId);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  return roots;
}
