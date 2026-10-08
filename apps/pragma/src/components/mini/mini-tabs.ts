import type { Project, Tab, Worktree } from "@pragma-sh/constants";

import { MINI_HOME_WORKTREE_ID, newMiniSessionId } from "@/lib/mini-window";

/** Where a mini tab's shell runs: the local home directory, or a project worktree. */
export type MiniLocation =
  | { kind: "home" }
  | {
      kind: "worktree";
      projectId: string;
      projectName: string;
      worktreeId: string;
      worktreeName: string;
    };

/**
 * A Pragma Mini tab. It is a full {@link Tab} so the shared tab chrome and
 * `terminalManager` take it unchanged, plus the cwd its shell starts in and a
 * description of where that is. Mini tabs are never persisted.
 */
export type MiniTab = Tab & { cwd: string; location: MiniLocation };

/** The tab strip of one mini window. */
export interface MiniTabsState {
  tabs: MiniTab[];
  activeTabId: string | null;
}

export const initialMiniTabsState: MiniTabsState = { tabs: [], activeTabId: null };

/** Display name of a worktree: its title, else its branch. */
export function worktreeName(worktree: Worktree): string {
  return worktree.title?.trim() || worktree.branch;
}

/** The location of `worktree` in `project`. */
export function worktreeLocation(project: Project, worktree: Worktree): MiniLocation {
  return {
    kind: "worktree",
    projectId: project.id,
    projectName: project.name,
    worktreeId: worktree.id,
    worktreeName: worktreeName(worktree),
  };
}

/** Short label for a location, used as a fresh tab's title. */
function locationLabel(location: MiniLocation): string | null {
  return location.kind === "home" ? null : `${location.projectName} · ${location.worktreeName}`;
}

/**
 * A new terminal tab at `location`, whose shell starts in `cwd`. Every tab gets
 * a fresh session id, so re-homing a tab is "replace with a new tab" rather than
 * mutating a live session.
 */
export function createMiniTab(location: MiniLocation, cwd: string): MiniTab {
  return {
    id: newMiniSessionId(),
    projectId: location.kind === "home" ? "" : location.projectId,
    worktreeId: location.kind === "home" ? MINI_HOME_WORKTREE_ID : location.worktreeId,
    kind: "terminal",
    title: locationLabel(location),
    url: null,
    filePath: null,
    whiteboardId: null,
    diffSide: null,
    diffCommit: null,
    prNumber: null,
    pluginId: null,
    pluginViewId: null,
    pluginPayload: null,
    pluginDedupeKey: null,
    agentId: null,
    userRenamed: false,
    orderIndex: 0,
    createdAt: new Date().toISOString(),
    cwd,
    location,
  };
}

/** Whether a tab is at `location` (the context menu marks the current one). */
export function isAtLocation(tab: MiniTab, location: MiniLocation): boolean {
  if (tab.location.kind !== location.kind) return false;
  return (
    tab.location.kind === "home" ||
    (location.kind === "worktree" && tab.location.worktreeId === location.worktreeId)
  );
}

export type MiniTabsAction =
  | { type: "open"; tab: MiniTab }
  | { type: "close"; tabId: string }
  | { type: "activate"; tabId: string }
  | { type: "cycle"; delta: number }
  | { type: "rename"; tabId: string; title: string }
  | { type: "shell-title"; tabId: string; title: string }
  | { type: "agent"; tabId: string; agentId: string; title: string }
  | { type: "replace"; tabId: string; tab: MiniTab };

/** State transitions of a mini window's tab strip. */
export function miniTabsReducer(state: MiniTabsState, action: MiniTabsAction): MiniTabsState {
  switch (action.type) {
    case "open":
      return { tabs: [...state.tabs, action.tab], activeTabId: action.tab.id };
    case "close":
      return closeTab(state, action.tabId);
    case "activate":
      return state.tabs.some((tab) => tab.id === action.tabId)
        ? { ...state, activeTabId: action.tabId }
        : state;
    case "cycle":
      return cycleTab(state, action.delta);
    case "rename":
      return updateTab(state, action.tabId, (tab) => ({
        ...tab,
        title: action.title,
        userRenamed: true,
      }));
    case "shell-title":
      // A user rename and an agent's name both outrank the shell's OSC title.
      return updateTab(state, action.tabId, (tab) =>
        tab.userRenamed || tab.agentId ? tab : { ...tab, title: action.title },
      );
    case "agent":
      return updateTab(state, action.tabId, (tab) => ({
        ...tab,
        agentId: action.agentId,
        title: tab.userRenamed ? tab.title : action.title,
      }));
    case "replace":
      return {
        tabs: state.tabs.map((tab) => (tab.id === action.tabId ? action.tab : tab)),
        activeTabId: state.activeTabId === action.tabId ? action.tab.id : state.activeTabId,
      };
  }
}

function updateTab(
  state: MiniTabsState,
  tabId: string,
  update: (tab: MiniTab) => MiniTab,
): MiniTabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === tabId ? update(tab) : tab)) };
}

/** Removes a tab; closing the active one activates its right neighbour, else its left. */
function closeTab(state: MiniTabsState, tabId: string): MiniTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (state.activeTabId !== tabId) return { tabs, activeTabId: state.activeTabId };
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeTabId: next?.id ?? null };
}

function cycleTab(state: MiniTabsState, delta: number): MiniTabsState {
  const count = state.tabs.length;
  if (count === 0) return state;
  const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const next = state.tabs[(((index + delta) % count) + count) % count];
  return next ? { ...state, activeTabId: next.id } : state;
}
