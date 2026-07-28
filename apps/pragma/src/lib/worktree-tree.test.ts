import type { Worktree } from "@pragma/constants";
import { describe, expect, it } from "vitest";

import { buildWorktreeTree } from "./worktree-tree";

function worktree(
  id: string,
  parentId: string | null,
  branch: string,
  isMain = false,
  hidden = false,
): Worktree {
  return {
    id,
    projectId: "project",
    parentId,
    branch,
    title: null,
    path: `/tmp/${id}`,
    isMain,
    hidden,
    createdAt: "now",
  };
}

describe("buildWorktreeTree", () => {
  it("nests worktrees by parent id and keeps main first", () => {
    const tree = buildWorktreeTree([
      worktree("child", "main", "feature"),
      worktree("main", null, "main", true),
      worktree("grandchild", "child", "nested"),
    ]);

    expect(tree[0]?.worktree.id).toBe("main");
    expect(tree[0]?.children[0]?.worktree.id).toBe("child");
    expect(tree[0]?.children[0]?.children[0]?.worktree.id).toBe("grandchild");
  });

  it("filters out rows that the predicate rejects and promotes their children", () => {
    // `parent` is hidden, but its children should still appear (promoted to
    // roots) so hiding a parent doesn't hide the rest of the tree.
    const tree = buildWorktreeTree(
      [
        worktree("main", null, "main", true),
        worktree("parent", "main", "feature", false, true),
        worktree("child", "parent", "nested"),
      ],
      { predicate: (w) => !w.hidden },
    );

    expect(tree.map((node) => node.worktree.id)).toEqual(["main", "child"]);
    expect(tree[1]?.worktree.id).toBe("child");
  });

  it("floats pinned worktrees to the top as roots, newest pin first", () => {
    const tree = buildWorktreeTree(
      [
        worktree("main", null, "main", true),
        worktree("alpha", "main", "alpha"),
        worktree("beta", "main", "beta"),
        worktree("gamma", "main", "gamma"),
      ],
      {
        pinTimes: new Map([
          ["alpha", 100],
          ["gamma", 300],
        ]),
      },
    );

    expect(tree.map((node) => node.worktree.id)).toEqual(["gamma", "alpha", "main"]);
    expect(tree[2]?.children.map((node) => node.worktree.id)).toEqual(["beta"]);
  });

  it("sorts pinned roots above unpinned when already a root", () => {
    const tree = buildWorktreeTree(
      [
        worktree("main", null, "main", true),
        worktree("pinned-root", null, "pinned"),
        worktree("other", null, "other"),
      ],
      { pinTimes: new Map([["pinned-root", 50]]) },
    );

    expect(tree.map((node) => node.worktree.id)).toEqual(["pinned-root", "main", "other"]);
  });
});
