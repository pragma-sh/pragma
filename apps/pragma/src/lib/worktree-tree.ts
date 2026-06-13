import type { Worktree } from "@pragma/constants";

export interface WorktreeNode {
  worktree: Worktree;
  children: WorktreeNode[];
}

export interface BuildWorktreeTreeOptions {
  /** When provided, only worktrees matching the predicate are kept. Useful
   *  for hiding rows without losing them. Children of a filtered-out parent
   *  are promoted to roots so the rest of the tree stays connected. */
  predicate?: (worktree: Worktree) => boolean;
}

/** Builds a nested tree from flat SQLite worktree rows. */
export function buildWorktreeTree(
  worktrees: Worktree[],
  options: BuildWorktreeTreeOptions = {},
): WorktreeNode[] {
  const nodes = new Map<string, WorktreeNode>();
  for (const worktree of worktrees) {
    if (options.predicate && !options.predicate(worktree)) {
      continue;
    }
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
