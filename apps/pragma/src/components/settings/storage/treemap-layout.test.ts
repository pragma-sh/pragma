import { describe, expect, it } from "vitest";

import type { StorageNode, StorageNodeKind } from "./storage-model";
import { layoutTreemap, leafAt, PROJECT_GUTTER } from "./treemap-layout";

const MB = 1024 * 1024;
const BOUNDS = { x: 0, y: 0, width: 400, height: 300 };

function node(
  id: string,
  kind: StorageNodeKind,
  bytes: number,
  children: StorageNode[] = [],
): StorageNode {
  return { id, label: id, path: id, bytes, fileCount: 1, kind, color: 0, children };
}

// What the host sends today: worktrees whose boxes are their top-level folders.
const src = node("src", "folder", 20 * MB);
const deps = node("node_modules", "folder", 60 * MB);
const rootFiles = node("wt/files", "files", 1 * MB);
const main = node("main", "worktree", 81 * MB, [src, deps, rootFiles]);
const feature = node("feature", "worktree", 9 * MB, [node("feature/src", "folder", 9 * MB)]);
const project = node("pragma", "project", 90 * MB, [main, feature]);

describe("layoutTreemap", () => {
  it("draws one box per top-level folder and fills the view", () => {
    const layout = layoutTreemap([project], BOUNDS);
    expect(layout.leaves.map((leaf) => leaf.node.id).toSorted()).toEqual(
      ["feature/src", "node_modules", "src", "wt/files"].toSorted(),
    );
    // Everything but the project's framed gutter.
    const inner = (BOUNDS.width - PROJECT_GUTTER * 2) * (BOUNDS.height - PROJECT_GUTTER * 2);
    const area = layout.leaves.reduce((sum, leaf) => sum + leaf.rect.width * leaf.rect.height, 0);
    expect(area).toBeCloseTo(inner, 3);
  });

  it("frames each project so its folders never touch another project's", () => {
    const other = node("other", "project", 30 * MB, [
      node("other/main", "worktree", 30 * MB, [node("other/src", "folder", 30 * MB)]),
    ]);
    const layout = layoutTreemap([project, other], BOUNDS);
    expect(layout.frames).toEqual([layout.boxes.get("pragma"), layout.boxes.get("other")]);
    const frame = layout.boxes.get("other")!;
    const leaf = layout.boxes.get("other/src")!;
    expect(leaf.x - frame.x).toBeCloseTo(PROJECT_GUTTER);
    expect(frame.x + frame.width - (leaf.x + leaf.width)).toBeCloseTo(PROJECT_GUTTER);
    // Inside a project, there is nothing left to frame.
    expect(layoutTreemap(project.children, BOUNDS).frames).toEqual([]);
  });

  it("zooms a click into the worktree a folder belongs to", () => {
    const layout = layoutTreemap([project], BOUNDS);
    const clickOf = (id: string) =>
      layout.leaves.find((leaf) => leaf.node.id === id)?.clickTarget?.id ?? null;
    expect(clickOf("node_modules")).toBe("main");
    expect(clickOf("feature/src")).toBe("feature");
  });

  it("steps the scroll wheel one level: the view's direct child", () => {
    const layout = layoutTreemap([project], BOUNDS);
    expect(layout.leaves.find((leaf) => leaf.node === src)?.region).toBe(project);
    // Inside a worktree, a folder has nothing more to zoom into.
    const inside = layoutTreemap(main.children, BOUNDS);
    expect(inside.leaves.find((leaf) => leaf.node === src)?.region).toBeNull();
    expect(inside.leaves.find((leaf) => leaf.node === src)?.clickTarget).toBeNull();
  });

  it("finds the box under a point", () => {
    const layout = layoutTreemap(main.children, BOUNDS);
    const box = layout.boxes.get("node_modules")!;
    expect(leafAt(layout.leaves, box.x + 1, box.y + 1)?.node).toBe(deps);
    expect(leafAt(layout.leaves, -5, -5)).toBeNull();
  });
});
