import type { Worktree } from "@pragma/constants";

export interface WorktreeNode {
  worktree: Worktree;
  children: WorktreeNode[];
}

/** Builds a nested tree from flat SQLite worktree rows. */
export function buildWorktreeTree(worktrees: Worktree[]): WorktreeNode[] {
  const nodes = new Map<string, WorktreeNode>();
  for (const worktree of worktrees) {
    nodes.set(worktree.id, { worktree, children: [] });
  }

  const roots: WorktreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.worktree.parentId && nodes.has(node.worktree.parentId)) {
      nodes.get(node.worktree.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots.toSorted(compareNodes);
}

function compareNodes(a: WorktreeNode, b: WorktreeNode): number {
  if (a.worktree.isMain !== b.worktree.isMain) {
    return a.worktree.isMain ? -1 : 1;
  }
  return labelFor(a.worktree).localeCompare(labelFor(b.worktree));
}

function labelFor(worktree: Worktree): string {
  return worktree.title ?? worktree.branch;
}
