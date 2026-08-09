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
  it("nests worktrees by parent id, with main a flat row on top", () => {
    const tree = buildWorktreeTree([
      worktree("child", "main", "feature"),
      worktree("main", null, "main", true),
      worktree("grandchild", "child", "nested"),
    ]);

    expect(tree.map((node) => node.worktree.id)).toEqual(["main", "child"]);
    expect(tree[0]?.children).toEqual([]);
    expect(tree[1]?.children[0]?.worktree.id).toBe("grandchild");
  });

  it("orders siblings by PR state: no PR, then open, then closed/merged", () => {
    const tree = buildWorktreeTree(
      [
        worktree("main", null, "main", true),
        worktree("merged", "main", "merged-branch"),
        worktree("bare", "main", "zzz-no-pr"),
        worktree("open", "main", "open-branch"),
        worktree("closed", "main", "aaa-closed"),
        worktree("draft", "main", "aaa-draft"),
      ],
      {
        prLifecycles: {
          merged: "merged",
          open: "open",
          closed: "closed",
          draft: "draft",
          bare: "none",
        },
      },
    );

    expect(tree.map((node) => node.worktree.id)).toEqual([
      "main",
      "bare",
      "draft",
      "open",
      "closed",
      "merged",
    ]);
  });

  it("orders a worktree with an unknown lifecycle by label, not as a no-PR row", () => {
    // `unknown` has no entry: its lookup is still loading or failed. It must not
    // jump ahead of `open`, whose PR did resolve — it falls back to label order.
    const tree = buildWorktreeTree(
      [
        worktree("main", null, "main", true),
        worktree("unknown", "main", "zzz-unknown"),
        worktree("open", "main", "aaa-open"),
        worktree("bare", "main", "bbb-no-pr"),
      ],
      { prLifecycles: { open: "open", bare: "none" } },
    );

    expect(tree.map((node) => node.worktree.id)).toEqual(["main", "bare", "open", "unknown"]);
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

    // Pinned rows lead, newest pin first; main heads the unpinned rows.
    expect(tree.map((node) => node.worktree.id)).toEqual(["gamma", "alpha", "main", "beta"]);
  });

  it("sorts pinned roots above main and other unpinned roots", () => {
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
