import type { Worktree } from "@pragma/constants";

import type { GitHubPrLifecycle } from "@/lib/github-cache";

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
  /** worktree id → PR lifecycle. Drives sibling ordering: worktrees with no PR
   *  come first, then open/draft PRs, then closed or merged ones. */
  prLifecycles?: Readonly<Record<string, GitHubPrLifecycle>>;
}

/**
 * Sort bucket for a worktree's PR state: 0 = no PR, 1 = open (incl. draft and
 * merging), 2 = closed or merged.
 */
function prSortRank(lifecycle: GitHubPrLifecycle | undefined): number {
  switch (lifecycle) {
    case "open":
    case "draft":
    case "merging":
      return 1;
    case "merged":
    case "closed":
      return 2;
    default:
      return 0;
  }
}

/**
 * Builds a nested tree from flat SQLite worktree rows.
 *
 * The main worktree is never a parent: its children are promoted to roots and
 * main itself is a plain row, first among the unpinned rows.
 */
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
    const parent = node.worktree.parentId ? nodes.get(node.worktree.parentId) : undefined;
    // Pinned rows float to the top of the sidebar as roots so pinning a nested
    // worktree actually moves it to the top, not just among its siblings. Main
    // is a flat entry, never a parent, so its children become roots too.
    if (!pinned && parent && !parent.worktree.isMain) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const compare = (a: WorktreeNode, b: WorktreeNode) => compareNodes(a, b, options);
  for (const node of nodes.values()) {
    node.children.sort(compare);
  }
  return roots.toSorted(compare);
}

function compareNodes(a: WorktreeNode, b: WorktreeNode, options: BuildWorktreeTreeOptions): number {
  const aPin = options.pinTimes?.get(a.worktree.id);
  const bPin = options.pinTimes?.get(b.worktree.id);
  const aPinned = aPin !== undefined;
  const bPinned = bPin !== undefined;
  if (aPinned !== bPinned) {
    return aPinned ? -1 : 1;
  }
  if (aPinned && bPinned) {
    // Newest pin first so clicking Pin moves the row to the top.
    return bPin - aPin;
  }
  // Main heads the unpinned rows.
  if (a.worktree.isMain !== b.worktree.isMain) {
    return a.worktree.isMain ? -1 : 1;
  }
  const rankDelta =
    prSortRank(options.prLifecycles?.[a.worktree.id]) -
    prSortRank(options.prLifecycles?.[b.worktree.id]);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  return labelFor(a.worktree).localeCompare(labelFor(b.worktree));
}

function labelFor(worktree: Worktree): string {
  return worktree.title ?? worktree.branch;
}
