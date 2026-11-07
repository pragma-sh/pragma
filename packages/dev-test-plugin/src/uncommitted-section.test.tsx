import { render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PluginWorktree } from "@pragma-sh/plugin";

import { createBridge, setBridge } from "./test/bridge";
import { uncommittedSection, UncommittedSection } from "./uncommitted-section";

const worktree: PluginWorktree = {
  id: "wt-1",
  projectId: "project",
  title: "feature",
  branch: "feature",
  path: "/repo/feature",
  isMain: false,
  selected: false,
};

const changes = {
  committed: [{ path: "old.ts" }],
  staged: [{ path: "a.ts" }],
  unstaged: [{ path: "a.ts" }, { path: "b.ts" }],
};

function bridgeWith(data: unknown, roots: Array<string | null> = []) {
  return createBridge({
    useWorktree: () => worktree,
    useWorktreeChanges: (root) => {
      roots.push(root);
      return { data: data as never, error: null, loading: data === undefined, refetch: () => {} };
    },
  });
}

describe("uncommittedSection", () => {
  it("counts each uncommitted path once, for the row's worktree", () => {
    const roots: Array<string | null> = [];
    setBridge(bridgeWith(changes, roots));

    const { result } = renderHook(() => uncommittedSection.useCount?.(worktree));

    expect(result.current).toBe(2);
    expect(roots).toContain("/repo/feature");
  });

  it("reports no count until the changes load", () => {
    setBridge(bridgeWith(undefined));

    const { result } = renderHook(() => uncommittedSection.useCount?.(worktree));

    expect(result.current).toBeNull();
  });

  it("lists the uncommitted paths of the worktree from useWorktree()", () => {
    setBridge(bridgeWith(changes));

    render(<UncommittedSection />);

    expect(screen.getByTestId("uncommitted-files")).toHaveTextContent("a.tsb.ts");
  });
});
