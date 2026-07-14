import { describe, expect, it } from "vitest";

import type { Worktree } from "@pragma/constants";

import { rankEditorWorktrees } from "./command-mode-ranking";

function worktree(id: string, branch: string, title: string | null = null): Worktree {
  return {
    id,
    projectId: "project-1",
    parentId: null,
    branch,
    title,
    path: `/repo/${id}`,
    isMain: id === "main",
    hidden: false,
    createdAt: "2026-07-13T00:00:00Z",
  };
}

describe("rankEditorWorktrees", () => {
  it("orders matching worktrees by most recent use", () => {
    const rows = [worktree("old", "feature/old"), worktree("new", "feature/new")];

    expect(rankEditorWorktrees(rows, "feature", { old: 1, new: 2 }).map((row) => row.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("matches display titles as well as branches", () => {
    const rows = [worktree("main", "main"), worktree("review", "fix/123", "Review fixes")];

    expect(rankEditorWorktrees(rows, "review", {}).map((row) => row.id)).toEqual(["review"]);
  });
});
