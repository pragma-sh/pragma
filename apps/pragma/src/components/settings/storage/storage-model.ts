import type { Project, StorageTreeEntry, Worktree, WorktreeStorage } from "@pragma-sh/constants";

/**
 * Turns per-worktree scan results into the box hierarchy the Storage page
 * draws. Pure, so the arithmetic that decides what a box contains — and the
 * color every box gets — is testable without drawing a treemap.
 */

/** One worktree the page measures, with the project it belongs to. */
export interface StorageTarget {
  project: Project;
  worktree: Worktree;
}

/** Where one worktree's scan stands. */
export type ScanState =
  | { status: "pending" }
  | { status: "done"; storage: WorktreeStorage }
  | { status: "error"; error: string };

/** What a box represents. */
export type StorageNodeKind = "project" | "worktree" | "folder" | "file" | "files" | "pending";

/** One box in the treemap. */
export interface StorageNode {
  id: string;
  label: string;
  /** Slash-joined location shown in the status bar. */
  path: string;
  bytes: number;
  /** Files an unexpanded entry stands for; the treemap draws that many tiles. */
  fileCount: number;
  kind: StorageNodeKind;
  /**
   * Palette slot. GrandPerspective's "color by folder": a folder's own files
   * share its color, and each subfolder takes the next slot after its
   * siblings, so neighboring folders never share one.
   */
  color: number;
  children: StorageNode[];
}

/** Placeholder weight for a worktree still being scanned, so it has a box. */
const PENDING_BYTES = 1;

/** The name a worktree is shown under. */
export function worktreeLabel(worktree: Worktree): string {
  return worktree.title?.trim() || worktree.branch;
}

/** The treemap shows a top-level folder only when it holds at least this much. */
export const TREEMAP_MIN_FOLDER_BYTES = 15 * 1024 * 1024;

/**
 * A worktree's boxes: its top-level folders of at least
 * {@link TREEMAP_MIN_FOLDER_BYTES}, one box each, sized by the folder's total.
 * Individual files — including those loose in the root — are never drawn.
 */
function topFolderNodes(
  entries: readonly StorageTreeEntry[],
  parent: { id: string; path: string; color: number },
): StorageNode[] {
  return entries
    .filter((entry) => entry.kind === "folder" && entry.bytes >= TREEMAP_MIN_FOLDER_BYTES)
    .map((entry, index) => ({
      id: `${parent.id}/folder:${entry.name}`,
      label: entry.name,
      path: `${parent.path}/${entry.name}`,
      bytes: entry.bytes,
      fileCount: entry.fileCount,
      kind: "folder",
      // Each folder takes the next palette slot, so neighbors never match.
      color: parent.color + index + 1,
      children: [],
    }));
}

/** One worktree's box, sized by its scan or a placeholder while pending. */
function worktreeNode(
  target: StorageTarget,
  state: ScanState | undefined,
  color: number,
  parentPath: string | null,
): StorageNode {
  const label = worktreeLabel(target.worktree);
  const base = {
    id: `worktree:${target.worktree.id}`,
    label,
    path: parentPath ? `${parentPath}/${label}` : label,
    color,
  };
  if (state?.status === "done") {
    const { tree } = state.storage;
    const children = topFolderNodes(tree ?? [], base);
    return {
      ...base,
      // The map shows only the large folders, so the worktree's box is their
      // sum. A host older than the tree omits it, and a worktree with no
      // qualifying folder would sum to zero and vanish; both stay one box.
      bytes:
        children.length > 0
          ? children.reduce((sum, child) => sum + child.bytes, 0)
          : state.storage.totalBytes,
      fileCount: state.storage.fileCount,
      kind: "worktree",
      children,
    };
  }
  return {
    ...base,
    path: state?.status === "error" ? `${base.path} — ${state.error}` : `${base.path} — scanning…`,
    bytes: PENDING_BYTES,
    fileCount: 0,
    kind: "pending",
    children: [],
  };
}

/** Top-level boxes: one per project (global) or one per worktree (project). */
export function buildStorageTree(
  targets: readonly StorageTarget[],
  states: Readonly<Record<string, ScanState>>,
  groupByProject: boolean,
): StorageNode[] {
  if (!groupByProject) {
    return targets.map((target, index) =>
      worktreeNode(target, states[target.worktree.id], index * 3, null),
    );
  }
  const projects = new Map<string, { project: Project; targets: StorageTarget[] }>();
  for (const target of targets) {
    const entry = projects.get(target.project.id) ?? { project: target.project, targets: [] };
    entry.targets.push(target);
    projects.set(target.project.id, entry);
  }
  return [...projects.values()].map(({ project, targets: members }, index) => {
    const color = index * 3;
    const children = members.map((target, member) =>
      worktreeNode(target, states[target.worktree.id], color + member, project.name),
    );
    return {
      id: `project:${project.id}`,
      label: project.name,
      path: project.name,
      bytes: children.reduce((sum, child) => sum + child.bytes, 0),
      fileCount: children.reduce((sum, child) => sum + child.fileCount, 0),
      kind: "project",
      color,
      children,
    };
  });
}

/** Aggregate numbers for the summary card. */
export interface StorageTotals {
  totalBytes: number;
  reclaimableBytes: number;
  scanned: number;
  failed: number;
  truncated: boolean;
}

/** Sums every finished scan; pending and failed worktrees contribute nothing. */
export function storageTotals(
  targets: readonly StorageTarget[],
  states: Readonly<Record<string, ScanState>>,
): StorageTotals {
  const totals: StorageTotals = {
    totalBytes: 0,
    reclaimableBytes: 0,
    scanned: 0,
    failed: 0,
    truncated: false,
  };
  for (const target of targets) {
    const state = states[target.worktree.id];
    if (state?.status === "error") totals.failed += 1;
    if (state?.status !== "done") continue;
    totals.scanned += 1;
    totals.totalBytes += state.storage.totalBytes;
    totals.truncated ||= state.storage.truncated;
    for (const folder of state.storage.ignoredFolders) totals.reclaimableBytes += folder.bytes;
  }
  return totals;
}

/**
 * Removes `segments` (a folder path) from a size tree, subtracting its bytes
 * from every ancestor. A folder the host never expanded simply shrinks.
 */
function pruneTree(
  entries: readonly StorageTreeEntry[],
  segments: readonly string[],
  bytes: number,
): StorageTreeEntry[] {
  const [head, ...rest] = segments;
  return entries.flatMap((entry) => {
    if (entry.kind !== "folder" || entry.name !== head) return [entry];
    if (rest.length === 0) return [];
    return [
      {
        ...entry,
        bytes: Math.max(0, entry.bytes - bytes),
        children: pruneTree(entry.children, rest, bytes),
      },
    ];
  });
}

/**
 * The scan as it stands after `path` was deleted: the folder, its bytes, and
 * any large file it contained are gone.
 */
export function withoutFolder(storage: WorktreeStorage, path: string): WorktreeStorage {
  const folder = storage.ignoredFolders.find((entry) => entry.path === path);
  if (!folder) return storage;
  const prefix = `${path}/`;
  return {
    ...storage,
    totalBytes: Math.max(0, storage.totalBytes - folder.bytes),
    fileCount: Math.max(0, storage.fileCount - folder.fileCount),
    ignoredBytes: Math.max(0, storage.ignoredBytes - folder.bytes),
    ignoredFolders: storage.ignoredFolders.filter((entry) => entry.path !== path),
    largeFiles: storage.largeFiles.filter((file) => !file.path.startsWith(prefix)),
    tree: pruneTree(storage.tree ?? [], path.split("/"), folder.bytes),
  };
}

/** Finds a node by id anywhere in the tree, with its ancestors. */
export function findNodePath(nodes: readonly StorageNode[], id: string): StorageNode[] | null {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const below = findNodePath(node.children, id);
    if (below) return [node, ...below];
  }
  return null;
}
