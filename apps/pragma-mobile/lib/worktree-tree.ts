import type { Worktree } from "@pragma/constants";

/** A worktree plus its nested children — mirrors the desktop sidebar tree. */
export interface WorktreeNode {
  worktree: Worktree;
  children: WorktreeNode[];
}

/**
 * Build a nested tree from flat worktree rows. Roots are worktrees with no
 * (resolvable) parent; children hang off `parentId`. Sorted main-first, then
 * by label. Kept in lockstep with `apps/pragma/src/lib/worktree-tree.ts`.
 */
export function buildWorktreeTree(worktrees: Worktree[]): WorktreeNode[] {
  const nodes = new Map<string, WorktreeNode>();
  for (const worktree of worktrees) {
    nodes.set(worktree.id, { worktree, children: [] });
  }

  const roots = linkRoots(nodes);
  sortNodes(roots);
  return roots;
}

/** Hang each node off its parent's `children`; return the parentless roots. */
function linkRoots(nodes: Map<string, WorktreeNode>): WorktreeNode[] {
  const roots: WorktreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.worktree.parentId ? nodes.get(node.worktree.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function sortNodes(nodes: WorktreeNode[]): void {
  nodes.sort(compareNodes);
  for (const node of nodes) {
    sortNodes(node.children);
  }
}

function compareNodes(a: WorktreeNode, b: WorktreeNode): number {
  if (a.worktree.isMain !== b.worktree.isMain) {
    return a.worktree.isMain ? -1 : 1;
  }
  return labelFor(a.worktree).localeCompare(labelFor(b.worktree));
}

/** A worktree's display label (`main` for the main worktree). */
export function worktreeLabel(worktree: Worktree): string {
  return worktree.isMain ? "main" : (worktree.title ?? worktree.branch);
}

function labelFor(worktree: Worktree): string {
  return worktree.title ?? worktree.branch;
}
