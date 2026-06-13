import type { Worktree } from "@pragma/constants";
import { describe, expect, it } from "vitest";

import { buildWorktreeTree } from "./worktree-tree";

function worktree(id: string, parentId: string | null, branch: string, isMain = false): Worktree {
  return {
    id,
    projectId: "project",
    parentId,
    branch,
    title: null,
    path: `/tmp/${id}`,
    isMain,
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
});
