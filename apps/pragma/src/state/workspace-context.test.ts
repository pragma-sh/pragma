import type { Project, Tab } from "@pragma/constants";
import { describe, expect, it } from "vitest";

import { type SplitLayoutNode, workspaceReducer } from "./workspace-context";

type WorkspaceState = Parameters<typeof workspaceReducer>[0];

const baseState: WorkspaceState = {
  projects: [],
  worktrees: {},
  tabs: [],
  selectedProjectId: null,
  selectedWorktreeByProject: {},
  activeTabByWorktree: {},
  splitRootByWorktree: {},
  focusedPaneByWorktree: {},
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
    kind: "terminal",
    title: null,
    url: null,
    filePath: null,
    diffSide: null,
    orderIndex: 0,
    createdAt: "now",
  };
}

function tabIdsInLayout(node: SplitLayoutNode | undefined): string[] {
  if (!node) {
    return [];
  }
  if (node.kind === "pane") {
    return node.tabIds;
  }
  return [...tabIdsInLayout(node.children[0]), ...tabIdsInLayout(node.children[1])];
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

  it("focuses a pane and switches to that pane's active tab", () => {
    const state = workspaceReducer(
      {
        ...baseState,
        tabs: [tab("one"), tab("two")],
        activeTabByWorktree: { worktree: "one" },
        splitRootByWorktree: {
          worktree: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            children: [
              { kind: "pane", id: "pane-left", tabIds: ["one"], activeTabId: "one" },
              { kind: "pane", id: "pane-right", tabIds: ["two"], activeTabId: "two" },
            ],
          },
        },
        focusedPaneByWorktree: { worktree: "pane-left" },
      },
      { type: "focus-pane", worktreeId: "worktree", paneId: "pane-right" },
    );

    expect(state.focusedPaneByWorktree.worktree).toBe("pane-right");
    expect(state.activeTabByWorktree.worktree).toBe("two");
  });

  it("splits the focused pane with a selected tab", () => {
    const state = workspaceReducer(
      {
        ...baseState,
        tabs: [tab("one"), tab("two")],
        activeTabByWorktree: { worktree: "one" },
      },
      {
        type: "split-pane",
        worktreeId: "worktree",
        paneId: null,
        tabId: "two",
        direction: "horizontal",
        placement: "after",
      },
    );

    const root = state.splitRootByWorktree.worktree;
    expect(root?.kind).toBe("split");
    expect(state.activeTabByWorktree.worktree).toBe("two");
    expect(state.focusedPaneByWorktree.worktree).toBeTruthy();
  });

  it("splits only the active tab against the dropped tab, leaving the rest normal", () => {
    const state = workspaceReducer(
      {
        ...baseState,
        tabs: [tab("one"), tab("two"), tab("three")],
        activeTabByWorktree: { worktree: "one" },
      },
      {
        type: "split-pane",
        worktreeId: "worktree",
        paneId: null,
        tabId: "two",
        direction: "horizontal",
        placement: "after",
      },
    );

    const root = state.splitRootByWorktree.worktree;
    expect(root?.kind).toBe("split");
    // The split holds the active tab (one) and the dropped tab (two); "three"
    // stays a normal top-bar tab rather than being pulled into the split.
    expect(tabIdsInLayout(root).toSorted()).toEqual(["one", "two"]);
  });

  it("keeps newly loaded tabs out of an existing split (the normal bar)", () => {
    const state = workspaceReducer(
      {
        ...baseState,
        tabs: [tab("one"), tab("two")],
        activeTabByWorktree: { worktree: "one" },
        splitRootByWorktree: {
          worktree: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            children: [
              { kind: "pane", id: "pane-default-worktree", tabIds: ["one"], activeTabId: "one" },
              { kind: "pane", id: "pane-right", tabIds: ["two"], activeTabId: "two" },
            ],
          },
        },
        focusedPaneByWorktree: { worktree: "pane-right" },
      },
      { type: "set-tabs", tabs: [tab("one"), tab("two"), tab("three")] },
    );

    expect(tabIdsInLayout(state.splitRootByWorktree.worktree).toSorted()).toEqual(["one", "two"]);
  });

  it("moves tabs between panes without duplicating them", () => {
    const split = workspaceReducer(
      {
        ...baseState,
        tabs: [tab("one"), tab("two"), tab("three")],
        activeTabByWorktree: { worktree: "one" },
      },
      {
        type: "split-pane",
        worktreeId: "worktree",
        paneId: null,
        tabId: "two",
        direction: "horizontal",
        placement: "after",
      },
    );
    const targetPaneId = split.focusedPaneByWorktree.worktree;
    const moved = workspaceReducer(split, {
      type: "move-tab-to-pane",
      worktreeId: "worktree",
      paneId: targetPaneId!,
      tabId: "three",
    });

    expect(
      tabIdsInLayout(moved.splitRootByWorktree.worktree).filter((id) => id === "three"),
    ).toHaveLength(1);
    expect(moved.activeTabByWorktree.worktree).toBe("three");
  });

  it("adds a new tab into a target pane and focuses it", () => {
    const state = workspaceReducer(
      {
        ...baseState,
        tabs: [tab("one"), tab("two")],
        activeTabByWorktree: { worktree: "one" },
        splitRootByWorktree: {
          worktree: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            children: [
              { kind: "pane", id: "pane-left", tabIds: ["one"], activeTabId: "one" },
              { kind: "pane", id: "pane-right", tabIds: ["two"], activeTabId: "two" },
            ],
          },
        },
        focusedPaneByWorktree: { worktree: "pane-left" },
      },
      { type: "add-tab-to-pane", tab: tab("three"), paneId: "pane-right" },
    );

    const right = state.splitRootByWorktree.worktree;
    expect(right?.kind === "split" ? right.children[1] : null).toMatchObject({
      id: "pane-right",
      tabIds: ["two", "three"],
      activeTabId: "three",
    });
    expect(state.activeTabByWorktree.worktree).toBe("three");
    expect(state.focusedPaneByWorktree.worktree).toBe("pane-right");
  });

  it("falls back to a normal tab when the target pane is gone", () => {
    const state = workspaceReducer(
      { ...baseState, tabs: [tab("one")], activeTabByWorktree: { worktree: "one" } },
      { type: "add-tab-to-pane", tab: tab("two"), paneId: "missing-pane" },
    );

    expect(state.tabs.map((t) => t.id)).toEqual(["one", "two"]);
    expect(state.activeTabByWorktree.worktree).toBe("two");
    expect(state.splitRootByWorktree.worktree).toBeUndefined();
  });

  it("does not change active tab when closing a non-active split tab", () => {
    const state = workspaceReducer(
      {
        ...baseState,
        tabs: [tab("one"), tab("two"), tab("three")],
        activeTabByWorktree: { worktree: "one" },
        splitRootByWorktree: {
          worktree: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            children: [
              { kind: "pane", id: "pane-left", tabIds: ["one", "two"], activeTabId: "one" },
              { kind: "pane", id: "pane-right", tabIds: ["three"], activeTabId: "three" },
            ],
          },
        },
        focusedPaneByWorktree: { worktree: "pane-left" },
      },
      { type: "remove-tab", tabId: "two" },
    );

    expect(state.activeTabByWorktree.worktree).toBe("one");
  });

  it("keeps focus in the same pane when closing the active split tab", () => {
    const state = workspaceReducer(
      {
        ...baseState,
        tabs: [tab("one"), tab("two"), tab("three")],
        activeTabByWorktree: { worktree: "one" },
        splitRootByWorktree: {
          worktree: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            children: [
              { kind: "pane", id: "pane-left", tabIds: ["one", "two"], activeTabId: "one" },
              { kind: "pane", id: "pane-right", tabIds: ["three"], activeTabId: "three" },
            ],
          },
        },
        focusedPaneByWorktree: { worktree: "pane-left" },
      },
      { type: "remove-tab", tabId: "one" },
    );

    expect(state.activeTabByWorktree.worktree).toBe("two");
    expect(state.splitRootByWorktree.worktree?.kind).toBe("split");
  });

  it("does not focus a tab restored to the normal bar when its pane collapses", () => {
    const state = workspaceReducer(
      {
        ...baseState,
        tabs: [tab("one"), tab("two"), tab("three")],
        activeTabByWorktree: { worktree: "one" },
        splitRootByWorktree: {
          worktree: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            children: [
              { kind: "pane", id: "pane-left", tabIds: ["one"], activeTabId: "one" },
              { kind: "pane", id: "pane-right", tabIds: ["two"], activeTabId: "two" },
            ],
          },
        },
        focusedPaneByWorktree: { worktree: "pane-left" },
      },
      { type: "remove-tab", tabId: "one" },
    );

    expect(state.splitRootByWorktree.worktree?.kind).toBe("pane");
    expect(state.activeTabByWorktree.worktree).toBe("three");
  });

  it("keeps split roots for worktrees outside the loaded project's tab snapshot", () => {
    const otherProjectSplit: SplitLayoutNode = {
      kind: "split",
      id: "split-1",
      direction: "horizontal",
      children: [
        { kind: "pane", id: "pane-left", tabIds: ["a"], activeTabId: "a" },
        { kind: "pane", id: "pane-right", tabIds: ["b"], activeTabId: "b" },
      ],
    };
    const state = workspaceReducer(
      {
        ...baseState,
        // Tabs/splits for a worktree that belongs to a *different* project.
        splitRootByWorktree: { "wt-other": otherProjectSplit },
      },
      // Switching projects replaces the tab list with the new project's tabs.
      { type: "set-tabs", tabs: [tab("one", "wt-current")] },
    );

    // The other project's split must survive the project switch in memory.
    expect(state.splitRootByWorktree["wt-other"]).toEqual(otherProjectSplit);
  });

  it("restores persisted splits, reconciling against the current tabs", () => {
    const state = workspaceReducer(
      {
        ...baseState,
        tabs: [tab("one"), tab("two")],
        activeTabByWorktree: { worktree: "one" },
      },
      {
        type: "set-splits",
        worktreeRoots: {
          worktree: {
            kind: "split",
            id: "split-1",
            direction: "vertical",
            children: [
              // "gone" was closed in a prior session and must be reconciled out.
              { kind: "pane", id: "pane-left", tabIds: ["one", "gone"], activeTabId: "one" },
              { kind: "pane", id: "pane-right", tabIds: ["two"], activeTabId: "two" },
            ],
          },
        },
      },
    );

    const root = state.splitRootByWorktree.worktree;
    expect(root?.kind).toBe("split");
    expect(tabIdsInLayout(root).toSorted()).toEqual(["one", "two"]);
  });

  it("merges new tabs into a single-pane root when tabs are loaded", () => {
    const state = workspaceReducer(
      {
        ...baseState,
        tabs: [tab("one")],
        activeTabByWorktree: { worktree: "one" },
        splitRootByWorktree: {
          worktree: {
            kind: "pane",
            id: "pane-default-worktree",
            tabIds: ["one"],
            activeTabId: "one",
          },
        },
        focusedPaneByWorktree: { worktree: "pane-default-worktree" },
      },
      { type: "set-tabs", tabs: [tab("one"), tab("two"), tab("three")] },
    );

    const root = state.splitRootByWorktree.worktree;
    expect(root?.kind).toBe("pane");
    if (root?.kind === "pane") {
      expect(root.tabIds).toEqual(["one", "two", "three"]);
    }
  });
});
