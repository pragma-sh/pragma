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
  /** worktree id → pin timestamp (ms). Pinned nodes float above unpinned
   *  siblings, newest pin first. */
  pinTimes?: ReadonlyMap<string, number>;
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
    const pinned = options.pinTimes?.has(node.worktree.id) === true;
    // Pinned rows float to the top of the sidebar as roots so pinning a nested
    // worktree actually moves it to the top, not just among its siblings.
    if (!pinned && node.worktree.parentId && nodes.has(node.worktree.parentId)) {
      nodes.get(node.worktree.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const compare = (a: WorktreeNode, b: WorktreeNode) => compareNodes(a, b, options.pinTimes);
  for (const node of nodes.values()) {
    node.children.sort(compare);
  }
  return roots.toSorted(compare);
}

function compareNodes(
  a: WorktreeNode,
  b: WorktreeNode,
  pinTimes?: ReadonlyMap<string, number>,
): number {
  const aPin = pinTimes?.get(a.worktree.id);
  const bPin = pinTimes?.get(b.worktree.id);
  const aPinned = aPin !== undefined;
  const bPinned = bPin !== undefined;
  if (aPinned !== bPinned) {
    return aPinned ? -1 : 1;
  }
  if (aPinned && bPinned) {
    // Newest pin first so clicking Pin moves the row to the top.
    return bPin - aPin;
  }
  if (a.worktree.isMain !== b.worktree.isMain) {
    return a.worktree.isMain ? -1 : 1;
  }
  return labelFor(a.worktree).localeCompare(labelFor(b.worktree));
}

function labelFor(worktree: Worktree): string {
  return worktree.title ?? worktree.branch;
}
