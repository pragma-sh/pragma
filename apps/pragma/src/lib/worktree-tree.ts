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
   *  come first, then open/draft PRs, then closed or merged ones. A worktree
   *  with no entry has an unknown lifecycle (still loading, or the lookup
   *  failed) and is left out of PR ordering entirely — pass `"none"` to say a
   *  worktree is known to have no PR. */
  prLifecycles?: Readonly<Record<string, GitHubPrLifecycle>>;
}

/**
 * Sort bucket for a worktree's PR state: 0 = no PR, 1 = open (incl. draft and
 * merging), 2 = closed or merged. `undefined` means the lifecycle is unknown
 * and the worktree is deliberately unranked.
 */
function prSortRank(lifecycle: GitHubPrLifecycle | undefined): number | undefined {
  switch (lifecycle) {
    case "none":
      return 0;
    case "open":
    case "draft":
    case "merging":
      return 1;
    case "merged":
    case "closed":
      return 2;
    default:
      return undefined;
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

/** Sibling order: pins, then main, then PR bucket, then label. */
function compareNodes(a: WorktreeNode, b: WorktreeNode, options: BuildWorktreeTreeOptions): number {
  return (
    comparePins(a, b, options.pinTimes) ||
    compareMain(a, b) ||
    comparePrRank(a, b, options.prLifecycles) ||
    labelFor(a.worktree).localeCompare(labelFor(b.worktree))
  );
}

/** Pinned rows above unpinned ones, newest pin first. */
function comparePins(
  a: WorktreeNode,
  b: WorktreeNode,
  pinTimes: ReadonlyMap<string, number> | undefined,
): number {
  const aPin = pinTimes?.get(a.worktree.id);
  const bPin = pinTimes?.get(b.worktree.id);
  if (aPin === undefined || bPin === undefined) {
    return Number(bPin !== undefined) - Number(aPin !== undefined);
  }
  return bPin - aPin;
}

/** Main heads the rows it is grouped with. */
function compareMain(a: WorktreeNode, b: WorktreeNode): number {
  return Number(b.worktree.isMain) - Number(a.worktree.isMain);
}

/**
 * No PR first, then open PRs, then closed or merged ones. A worktree whose
 * lifecycle is unknown ties, so it falls through to label ordering instead of
 * claiming the no-PR bucket ahead of worktrees that do have a PR.
 */
function comparePrRank(
  a: WorktreeNode,
  b: WorktreeNode,
  prLifecycles: Readonly<Record<string, GitHubPrLifecycle>> | undefined,
): number {
  const aRank = prSortRank(prLifecycles?.[a.worktree.id]);
  const bRank = prSortRank(prLifecycles?.[b.worktree.id]);
  if (aRank === undefined || bRank === undefined) {
    return 0;
  }
  return aRank - bRank;
}

function labelFor(worktree: Worktree): string {
  return worktree.title ?? worktree.branch;
}
