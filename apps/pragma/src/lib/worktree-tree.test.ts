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
});
