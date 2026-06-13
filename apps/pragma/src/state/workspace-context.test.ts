import type { Project, Tab } from "@pragma/constants";
import { describe, expect, it } from "vitest";

import { workspaceReducer } from "./workspace-context";

type WorkspaceState = Parameters<typeof workspaceReducer>[0];

const baseState: WorkspaceState = {
  projects: [],
  worktrees: {},
  tabs: [],
  selectedProjectId: null,
  selectedWorktreeByProject: {},
  activeTabByWorktree: {},
  icons: {},
  loading: true,
  error: null,
};

function project(id: string): Project {
  return { id, name: id, path: `/tmp/${id}`, orderIndex: 0, createdAt: "now" };
}

function tab(id: string, worktreeId = "worktree"): Tab {
  return {
    id,
    projectId: "project",
    worktreeId,
    title: null,
    orderIndex: 0,
    createdAt: "now",
  };
}

describe("workspaceReducer", () => {
  it("selects the first project when projects load", () => {
    const state = workspaceReducer(baseState, { type: "set-projects", projects: [project("one")] });
    expect(state.selectedProjectId).toBe("one");
    expect(state.loading).toBe(false);
  });

  it("activates new tabs and selects a fallback when one closes", () => {
    const withTabs = workspaceReducer(
      { ...baseState, tabs: [tab("one")], activeTabByWorktree: { worktree: "one" } },
      { type: "add-tab", tab: tab("two") },
    );
    expect(withTabs.activeTabByWorktree.worktree).toBe("two");
    const closed = workspaceReducer(withTabs, { type: "remove-tab", tabId: "two" });
    expect(closed.activeTabByWorktree.worktree).toBe("one");
  });

  it("keeps tabs scoped to their own worktree", () => {
    const withTwoWorktrees = workspaceReducer(
      { ...baseState, selectedProjectId: "project", tabs: [tab("a", "wt-1")] },
      { type: "add-tab", tab: tab("b", "wt-2") },
    );
    expect(withTwoWorktrees.tabs.filter((t) => t.worktreeId === "wt-1")).toHaveLength(1);
    expect(withTwoWorktrees.tabs.filter((t) => t.worktreeId === "wt-2")).toHaveLength(1);
    expect(withTwoWorktrees.activeTabByWorktree).toEqual({ "wt-2": "b" });
  });

  it("remembers the selected worktree per project", () => {
    const state = workspaceReducer(
      { ...baseState, selectedProjectId: "project" },
      { type: "select-worktree", projectId: "project", worktreeId: "wt-9" },
    );
    expect(state.selectedWorktreeByProject.project).toBe("wt-9");
  });
});
