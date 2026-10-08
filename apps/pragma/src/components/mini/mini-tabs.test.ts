import { describe, expect, it } from "vitest";

import type { Project, Worktree } from "@pragma-sh/constants";

import {
  createMiniTab,
  initialMiniTabsState,
  isAtLocation,
  type MiniLocation,
  miniTabsReducer,
  type MiniTabsState,
  worktreeLocation,
} from "@/components/mini/mini-tabs";
import { isMiniSessionId, MINI_HOME_WORKTREE_ID } from "@/lib/mini-window";

const HOME: MiniLocation = { kind: "home" };
const project: Project = {
  id: "p1",
  name: "pragma",
  path: "/repo",
  iconEmoji: null,
  orderIndex: 0,
  createdAt: "",
};
const worktree: Worktree = {
  id: "w1",
  projectId: "p1",
  parentId: null,
  branch: "feature/x",
  title: null,
  path: "/repo/.pragma/worktrees/w1",
  isMain: false,
  hidden: false,
  createdAt: "",
};

function withTabs(count: number): MiniTabsState {
  let state = initialMiniTabsState;
  for (let index = 0; index < count; index += 1) {
    state = miniTabsReducer(state, { type: "open", tab: createMiniTab(HOME, "/home/me") });
  }
  return state;
}

describe("createMiniTab", () => {
  it("routes a home tab to the local sentinel worktree", () => {
    const tab = createMiniTab(HOME, "/home/me");
    expect(tab.worktreeId).toBe(MINI_HOME_WORKTREE_ID);
    expect(tab.cwd).toBe("/home/me");
    expect(isMiniSessionId(tab.id)).toBe(true);
  });

  it("names a worktree tab after its project and branch", () => {
    const tab = createMiniTab(worktreeLocation(project, worktree), worktree.path);
    expect(tab.worktreeId).toBe("w1");
    expect(tab.projectId).toBe("p1");
    expect(tab.title).toBe("pragma · feature/x");
  });
});

describe("miniTabsReducer", () => {
  it("activates each opened tab", () => {
    const state = withTabs(2);
    expect(state.activeTabId).toBe(state.tabs[1]!.id);
  });

  it("closing the active tab activates its right neighbour, else the left", () => {
    const state = withTabs(3);
    const [first, second, third] = state.tabs;
    const middle = miniTabsReducer(
      miniTabsReducer(state, { type: "activate", tabId: second!.id }),
      { type: "close", tabId: second!.id },
    );
    expect(middle.activeTabId).toBe(third!.id);
    const last = miniTabsReducer(middle, { type: "close", tabId: third!.id });
    expect(last.activeTabId).toBe(first!.id);
    expect(miniTabsReducer(last, { type: "close", tabId: first!.id }).activeTabId).toBeNull();
  });

  it("cycles in both directions with wrap-around", () => {
    const state = withTabs(3);
    const forward = miniTabsReducer(state, { type: "cycle", delta: 1 });
    expect(forward.activeTabId).toBe(state.tabs[0]!.id);
    const back = miniTabsReducer(forward, { type: "cycle", delta: -1 });
    expect(back.activeTabId).toBe(state.tabs[2]!.id);
  });

  it("lets a rename outrank later shell titles", () => {
    const state = withTabs(1);
    const id = state.tabs[0]!.id;
    const titled = miniTabsReducer(state, { type: "shell-title", tabId: id, title: "zsh" });
    expect(titled.tabs[0]!.title).toBe("zsh");
    const renamed = miniTabsReducer(titled, { type: "rename", tabId: id, title: "mine" });
    const ignored = miniTabsReducer(renamed, { type: "shell-title", tabId: id, title: "vim" });
    expect(ignored.tabs[0]!.title).toBe("mine");
  });

  it("keeps an agent's name over shell titles", () => {
    const state = withTabs(1);
    const id = state.tabs[0]!.id;
    const agent = miniTabsReducer(state, {
      type: "agent",
      tabId: id,
      agentId: "claude-code",
      title: "Claude Code",
    });
    const ignored = miniTabsReducer(agent, { type: "shell-title", tabId: id, title: "node" });
    expect(ignored.tabs[0]!.title).toBe("Claude Code");
    expect(ignored.tabs[0]!.agentId).toBe("claude-code");
  });

  it("re-homes a tab in place and keeps it active", () => {
    const state = withTabs(2);
    const first = state.tabs[0]!;
    const activated = miniTabsReducer(state, { type: "activate", tabId: first.id });
    const moved = createMiniTab(worktreeLocation(project, worktree), worktree.path);
    const next = miniTabsReducer(activated, { type: "replace", tabId: first.id, tab: moved });
    expect(next.tabs[0]!.id).toBe(moved.id);
    expect(next.activeTabId).toBe(moved.id);
    expect(isAtLocation(next.tabs[0]!, worktreeLocation(project, worktree))).toBe(true);
    expect(isAtLocation(next.tabs[0]!, HOME)).toBe(false);
  });
});
