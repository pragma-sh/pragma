import type { Project, Worktree, WorktreeStorage } from "@pragma-sh/constants";
import { describe, expect, it } from "vitest";

import {
  buildStorageTree,
  findNodePath,
  storageTotals,
  withoutFolder,
  type ScanState,
  type StorageNode,
  type StorageTarget,
} from "./storage-model";

const MB = 1024 * 1024;

function project(id: string): Project {
  return {
    id,
    name: `Project ${id}`,
    path: `/p/${id}`,
    iconEmoji: null,
    orderIndex: 0,
    createdAt: "",
  };
}

function worktree(id: string, projectId: string, title: string | null = null): Worktree {
  return {
    id,
    projectId,
    parentId: null,
    branch: `branch-${id}`,
    title,
    path: `/p/${projectId}/${id}`,
    isMain: false,
    hidden: false,
    createdAt: "",
  } as Worktree;
}

function storage(overrides: Partial<WorktreeStorage> = {}): WorktreeStorage {
  return {
    totalBytes: 100 * MB,
    fileCount: 1000,
    gitBytes: 10 * MB,
    ignoredBytes: 60 * MB,
    largeFiles: [
      { path: "apps/web/node_modules/big.node", bytes: 20 * MB, ignored: true },
      { path: "assets/video.mp4", bytes: 15 * MB, ignored: false },
    ],
    ignoredFolders: [{ path: "apps/web/node_modules", bytes: 60 * MB, fileCount: 900 }],
    truncated: false,
    tree: [
      {
        name: "apps",
        bytes: 70 * MB,
        fileCount: 5,
        kind: "folder",
        children: [
          {
            name: "web",
            bytes: 70 * MB,
            fileCount: 5,
            kind: "folder",
            children: [
              { name: "node_modules", bytes: 60 * MB, fileCount: 1, kind: "folder", children: [] },
              { name: "index.ts", bytes: 10 * MB, fileCount: 1, kind: "file", children: [] },
            ],
          },
        ],
      },
      { name: "assets", bytes: 15 * MB, fileCount: 1, kind: "folder", children: [] },
      { name: ".git", bytes: 10 * MB, fileCount: 1, kind: "folder", children: [] },
      { name: "", bytes: 5 * MB, fileCount: 1, kind: "files", children: [] },
    ],
    ...overrides,
  };
}

const a = project("a");
const b = project("b");
const targets: StorageTarget[] = [
  { project: a, worktree: worktree("a1", "a", "Main") },
  { project: a, worktree: worktree("a2", "a") },
  { project: b, worktree: worktree("b1", "b") },
];

const states: Record<string, ScanState> = {
  a1: { status: "done", storage: storage() },
  a2: { status: "pending" },
  b1: { status: "error", error: "host offline" },
};

function childNamed(node: StorageNode | undefined, label: string): StorageNode | undefined {
  return node?.children.find((child) => child.label === label);
}

describe("buildStorageTree", () => {
  it("groups worktrees under project boxes in global scope", () => {
    const nodes = buildStorageTree(targets, states, true);
    expect(nodes.map((node) => node.label)).toEqual(["Project a", "Project b"]);
    expect(nodes[0]?.children.map((node) => node.label)).toEqual(["Main", "branch-a2"]);
    expect(nodes[0]?.color).not.toBe(nodes[1]?.color);
  });

  it("puts worktrees at the top level in project scope", () => {
    const nodes = buildStorageTree(targets.slice(0, 2), states, false);
    expect(nodes.map((node) => node.kind)).toEqual(["worktree", "pending"]);
  });

  it("shows only top-level folders of 15 MB or more, never files", () => {
    const [main] = buildStorageTree(targets.slice(0, 1), states, false);
    // `.git` (10 MB) and the root's loose files (5 MB) are left out.
    expect(main?.children.map((child) => child.label)).toEqual(["apps", "assets"]);
    expect(main?.children.every((child) => child.kind === "folder")).toBe(true);
    // Top-level folders are shown whole, as their total.
    expect(childNamed(main, "apps")?.children).toEqual([]);
    expect(childNamed(main, "apps")?.bytes).toBe(70 * MB);
    expect(childNamed(main, "apps")?.path).toBe("Main/apps");
  });

  it("sizes a worktree's box by the folders it shows", () => {
    const [main] = buildStorageTree(targets.slice(0, 1), states, false);
    expect(main?.bytes).toBe(85 * MB);
  });

  it("gives neighboring folders different colors", () => {
    const [main] = buildStorageTree(targets.slice(0, 1), states, false);
    const colors = main?.children.map((child) => child.color) ?? [];
    expect(new Set(colors).size).toBe(colors.length);
    expect(colors).not.toContain(main?.color);
  });

  it("draws a worktree from an older host, which sends no tree, as one box", () => {
    const { tree: _omitted, ...legacy } = storage();
    const [node] = buildStorageTree(
      targets.slice(0, 1),
      { a1: { status: "done", storage: legacy } },
      false,
    );
    expect(node?.kind).toBe("worktree");
    expect(node?.bytes).toBe(100 * MB);
    expect(node?.children).toEqual([]);
    expect(node?.fileCount).toBe(1000);
  });

  it("finds a node with its ancestors", () => {
    const nodes = buildStorageTree(targets, states, true);
    const assets = childNamed(childNamed(nodes[0], "Main"), "assets");
    const trail = findNodePath(nodes, assets?.id ?? "");
    expect(trail?.map((node) => node.label)).toEqual(["Project a", "Main", "assets"]);
    expect(findNodePath(nodes, "missing")).toBeNull();
  });
});

describe("storageTotals", () => {
  it("sums finished scans and counts failures", () => {
    const totals = storageTotals(targets, {
      a1: { status: "done", storage: storage() },
      a2: {
        status: "done",
        storage: storage({ totalBytes: 5 * MB, ignoredFolders: [], truncated: true }),
      },
      b1: { status: "error", error: "nope" },
    });
    expect(totals).toEqual({
      totalBytes: 105 * MB,
      reclaimableBytes: 60 * MB,
      scanned: 2,
      failed: 1,
      truncated: true,
    });
  });
});

describe("withoutFolder", () => {
  it("subtracts the folder from the totals, the large files, and the tree", () => {
    const next = withoutFolder(storage(), "apps/web/node_modules");
    expect(next.totalBytes).toBe(40 * MB);
    expect(next.ignoredBytes).toBe(0);
    expect(next.ignoredFolders).toEqual([]);
    expect(next.largeFiles.map((file) => file.path)).toEqual(["assets/video.mp4"]);
    const apps = next.tree?.[0];
    expect(apps?.bytes).toBe(10 * MB);
    expect(apps?.children[0]?.children.map((entry) => entry.name)).toEqual(["index.ts"]);
  });

  it("shrinks a folder the host never expanded", () => {
    const collapsed = storage({
      tree: [{ name: "apps", bytes: 70 * MB, fileCount: 1, kind: "folder", children: [] }],
    });
    expect(withoutFolder(collapsed, "apps/web/node_modules").tree?.[0]?.bytes).toBe(10 * MB);
  });

  it("ignores an unknown folder", () => {
    const before = storage();
    expect(withoutFolder(before, "dist")).toBe(before);
  });
});
