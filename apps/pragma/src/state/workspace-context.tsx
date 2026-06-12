import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import type { Project, Tab, Worktree } from "@pragma/constants";

export interface WorkspaceState {
  projects: Project[];
  activeProjectId: string | null;
  worktrees: Worktree[];
  selectedWorktreeId: string | null;
  tabs: Tab[];
  activeTabId: string | null;
  /** Tab ids whose daemon session already exists and should be reattached (vs spawned). */
  attachableTabIds: Set<string>;
  iconCache: Map<string, string>;
  projectsDirectory: string | null;
}

type Action =
  | { type: "SET_PROJECTS"; projects: Project[]; activeProjectId?: string }
  | { type: "SET_ACTIVE_PROJECT"; projectId: string }
  | { type: "SET_WORKTREES"; worktrees: Worktree[]; selectedWorktreeId?: string }
  | { type: "SELECT_WORKTREE"; worktreeId: string }
  | { type: "SET_TABS"; tabs: Tab[]; activeTabId?: string }
  | { type: "ADD_TAB"; tab: Tab }
  | { type: "REMOVE_TAB"; tabId: string }
  | { type: "SET_ACTIVE_TAB"; tabId: string }
  | { type: "SET_ICON"; projectId: string; data: string }
  | { type: "SET_PROJECTS_DIRECTORY"; dir: string };

function reducer(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case "SET_PROJECTS":
      return {
        ...state,
        projects: action.projects,
        activeProjectId: action.activeProjectId ?? action.projects[0]?.id ?? null,
      };
    case "SET_ACTIVE_PROJECT":
      // Re-selecting the active project would wipe worktrees/tabs without the
      // load effect refiring (its dependency wouldn't change), so no-op instead.
      if (action.projectId === state.activeProjectId) return state;
      return {
        ...state,
        activeProjectId: action.projectId,
        worktrees: [],
        selectedWorktreeId: null,
        tabs: [],
        activeTabId: null,
        attachableTabIds: new Set(),
      };
    case "SET_WORKTREES":
      return {
        ...state,
        worktrees: action.worktrees,
        selectedWorktreeId:
          action.selectedWorktreeId ??
          action.worktrees.find((w) => w.isMain)?.id ??
          action.worktrees[0]?.id ??
          null,
      };
    case "SELECT_WORKTREE":
      return { ...state, selectedWorktreeId: action.worktreeId };
    case "SET_TABS":
      return {
        ...state,
        tabs: action.tabs,
        activeTabId: action.activeTabId ?? action.tabs[0]?.id ?? null,
        // Tabs loaded from persistence reattach to live daemon sessions.
        attachableTabIds: new Set(action.tabs.map((t) => t.id)),
      };
    case "ADD_TAB":
      return { ...state, tabs: [...state.tabs, action.tab], activeTabId: action.tab.id };
    case "REMOVE_TAB": {
      const tabs = state.tabs.filter((t) => t.id !== action.tabId);
      return {
        ...state,
        tabs,
        activeTabId: state.activeTabId === action.tabId ? (tabs[0]?.id ?? null) : state.activeTabId,
      };
    }
    case "SET_ACTIVE_TAB":
      return { ...state, activeTabId: action.tabId };
    case "SET_ICON": {
      const cache = new Map(state.iconCache);
      cache.set(action.projectId, action.data);
      return { ...state, iconCache: cache };
    }
    case "SET_PROJECTS_DIRECTORY":
      return { ...state, projectsDirectory: action.dir };
    default:
      return state;
  }
}

const initialState: WorkspaceState = {
  projects: [],
  activeProjectId: null,
  worktrees: [],
  selectedWorktreeId: null,
  tabs: [],
  activeTabId: null,
  attachableTabIds: new Set(),
  iconCache: new Map(),
  projectsDirectory: null,
};

const WorkspaceContext = createContext<{
  state: WorkspaceState;
  dispatch: Dispatch<Action>;
} | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
