import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";

import type { Project, ProjectIcon, Tab, Worktree, WorktreeStatus } from "@pragma/constants";

import { BROWSER_START_URL } from "@/lib/browser-manager";
import { terminalManager } from "@/lib/terminal-manager";
import {
  browserClose,
  closeTab as closeTabCommand,
  createTab as createTabCommand,
  deleteWorktree as deleteWorktreeCommand,
  listProjects,
  listTabs,
  listWorktrees,
  onBrowserMeta,
  openWorktree as openWorktreeCommand,
  projectIcon,
  renameTab as renameTabCommand,
  renameWorktree as renameWorktreeCommand,
  setTabUrl as setTabUrlCommand,
  setWorktreeHidden as setWorktreeHiddenCommand,
  worktreeStatus as worktreeStatusCommand,
} from "@/lib/tauri";

interface WorkspaceState {
  projects: Project[];
  worktrees: Record<string, Worktree[]>;
  /** Every loaded tab across worktrees; the visible set is filtered per worktree. */
  tabs: Tab[];
  selectedProjectId: string | null;
  /** Last selected worktree per project, so switching projects restores context. */
  selectedWorktreeByProject: Record<string, string>;
  /** Last active tab per worktree, so each worktree keeps its own focused tab. */
  activeTabByWorktree: Record<string, string>;
  icons: Record<string, ProjectIcon | null>;
  loading: boolean;
  error: string | null;
}

type WorkspaceAction =
  | { type: "load-start" }
  | { type: "load-error"; error: string }
  | { type: "set-projects"; projects: Project[] }
  | { type: "set-worktrees"; projectId: string; worktrees: Worktree[] }
  | { type: "set-tabs"; tabs: Tab[] }
  | { type: "select-project"; projectId: string | null }
  | { type: "select-worktree"; projectId: string; worktreeId: string }
  | { type: "set-active-tab"; worktreeId: string; tabId: string }
  | { type: "add-tab"; tab: Tab }
  | { type: "remove-tab"; tabId: string }
  | { type: "rename-tab"; tabId: string; title: string }
  | { type: "set-tab-url"; tabId: string; url: string }
  | { type: "set-icon"; projectId: string; icon: ProjectIcon | null }
  | { type: "remove-worktree"; worktreeId: string }
  | { type: "update-worktree"; worktree: Worktree }
  | { type: "clear-error" };

interface WorkspaceContextValue extends WorkspaceState {
  /** Tabs belonging to the selected worktree (the visible set). */
  tabs: Tab[];
  selectedWorktreeId: string | null;
  activeTabId: string | null;
  activeProject: Project | null;
  selectedWorktree: Worktree | null;
  activeTab: Tab | null;
  reload: () => Promise<void>;
  refreshProject: (projectId?: string | null) => Promise<void>;
  selectProject: (projectId: string | null) => Promise<void>;
  selectWorktree: (worktreeId: string | null) => void;
  createTerminalTab: (worktreeId?: string) => Promise<void>;
  createBrowserTab: (worktreeId?: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  renameTerminalTab: (tabId: string, title: string) => Promise<void>;
  openSelectedWorktree: (editorId?: string | null) => Promise<void>;
  openWorktreeInEditor: (worktreeId: string, editorId?: string | null) => Promise<void>;
  cycleTab: (direction: 1 | -1) => void;
  setActiveTab: (tabId: string | null) => void;
  /** Reports whether a worktree has uncommitted, staged, or untracked changes. */
  getWorktreeStatus: (worktreeId: string) => Promise<WorktreeStatus>;
  /** Removes a worktree from disk + SQLite, optionally deletes its branch. */
  deleteWorktree: (
    worktreeId: string,
    options: { deleteBranch: boolean; force: boolean },
  ) => Promise<void>;
  /** Updates the optional display title; empty string clears it. */
  renameWorktree: (worktreeId: string, title: string) => Promise<void>;
  /** Toggles the hidden flag — the row persists, but the sidebar filters it out. */
  hideWorktree: (worktreeId: string, hidden: boolean) => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const initialState: WorkspaceState = {
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

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "load-start":
      return { ...state, loading: true, error: null };
    case "load-error":
      return { ...state, loading: false, error: action.error };
    case "set-projects": {
      const selectedProjectId = state.selectedProjectId ?? action.projects[0]?.id ?? null;
      return { ...state, projects: action.projects, selectedProjectId, loading: false };
    }
    case "set-worktrees": {
      // Keep the remembered worktree if it still exists; otherwise fall back to main.
      const remembered = state.selectedWorktreeByProject[action.projectId];
      const fallback =
        action.worktrees.find((worktree) => worktree.isMain)?.id ?? action.worktrees[0]?.id;
      const selectedWorktreeId =
        remembered && action.worktrees.some((worktree) => worktree.id === remembered)
          ? remembered
          : fallback;
      return {
        ...state,
        worktrees: { ...state.worktrees, [action.projectId]: action.worktrees },
        selectedWorktreeByProject: selectedWorktreeId
          ? { ...state.selectedWorktreeByProject, [action.projectId]: selectedWorktreeId }
          : state.selectedWorktreeByProject,
      };
    }
    case "set-tabs":
      return { ...state, tabs: action.tabs };
    case "select-project":
      return { ...state, selectedProjectId: action.projectId };
    case "select-worktree":
      return {
        ...state,
        selectedWorktreeByProject: {
          ...state.selectedWorktreeByProject,
          [action.projectId]: action.worktreeId,
        },
      };
    case "set-active-tab":
      return {
        ...state,
        activeTabByWorktree: {
          ...state.activeTabByWorktree,
          [action.worktreeId]: action.tabId,
        },
      };
    case "add-tab":
      return {
        ...state,
        tabs: [...state.tabs, action.tab],
        activeTabByWorktree: {
          ...state.activeTabByWorktree,
          [action.tab.worktreeId]: action.tab.id,
        },
      };
    case "remove-tab": {
      const removed = state.tabs.find((tab) => tab.id === action.tabId);
      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
      let activeTabByWorktree = state.activeTabByWorktree;
      if (removed && state.activeTabByWorktree[removed.worktreeId] === action.tabId) {
        const fallback = tabs.findLast((tab) => tab.worktreeId === removed.worktreeId)?.id;
        activeTabByWorktree = { ...activeTabByWorktree };
        if (fallback) {
          activeTabByWorktree[removed.worktreeId] = fallback;
        } else {
          delete activeTabByWorktree[removed.worktreeId];
        }
      }
      return { ...state, tabs, activeTabByWorktree };
    }
    case "rename-tab":
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.tabId ? { ...tab, title: action.title } : tab,
        ),
      };
    case "set-tab-url":
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.tabId ? { ...tab, url: action.url } : tab,
        ),
      };
    case "set-icon":
      return { ...state, icons: { ...state.icons, [action.projectId]: action.icon } };
    case "remove-worktree": {
      // Filter the row out of every project list and drop tabs owned by it
      // (SQLite cascades, but our local snapshot still has them). The Tauri
      // side has already terminated the worktree's PTY sessions by the time
      // we get here, so we just need to keep the in-memory state in sync.
      const worktrees: Record<string, Worktree[]> = {};
      const selectedWorktreeByProject: Record<string, string> = {
        ...state.selectedWorktreeByProject,
      };
      for (const [projectId, projectWorktrees] of Object.entries(state.worktrees)) {
        const remaining = projectWorktrees.filter((worktree) => worktree.id !== action.worktreeId);
        if (remaining.length === projectWorktrees.length) {
          worktrees[projectId] = projectWorktrees;
          continue;
        }
        worktrees[projectId] = remaining;
        if (selectedWorktreeByProject[projectId] === action.worktreeId) {
          const fallback =
            remaining.find((worktree) => worktree.isMain)?.id ??
            remaining.find((worktree) => worktree.parentId === null)?.id ??
            remaining[0]?.id;
          if (fallback) {
            selectedWorktreeByProject[projectId] = fallback;
          } else {
            delete selectedWorktreeByProject[projectId];
          }
        }
      }
      const tabs = state.tabs.filter((tab) => tab.worktreeId !== action.worktreeId);
      return { ...state, worktrees, selectedWorktreeByProject, tabs };
    }
    case "update-worktree": {
      // Patch a single worktree row in-place (rename, hide/show). Cascades to
      // the visible worktrees and the per-worktree active-tab map is
      // untouched because ids don't change.
      const worktrees: Record<string, Worktree[]> = {};
      for (const [projectId, projectWorktrees] of Object.entries(state.worktrees)) {
        worktrees[projectId] = projectWorktrees.map((worktree) =>
          worktree.id === action.worktree.id ? action.worktree : worktree,
        );
      }
      return { ...state, worktrees };
    }
    case "clear-error":
      return { ...state, error: null };
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, initialState);

  // Latest selected project, readable from async callbacks without re-creating
  // them on every selection change.
  const selectedProjectIdRef = useRef(state.selectedProjectId);
  selectedProjectIdRef.current = state.selectedProjectId;

  const reload = useCallback(async () => {
    dispatch({ type: "load-start" });
    try {
      const projects = await listProjects();
      dispatch({ type: "set-projects", projects });
    } catch (cause) {
      dispatch({ type: "load-error", error: messageFor(cause) });
    }
  }, []);

  const selectProject = useCallback(async (projectId: string | null) => {
    dispatch({ type: "select-project", projectId });
  }, []);

  const refreshProject = useCallback(async (projectId?: string | null) => {
    const targetProjectId = projectId ?? selectedProjectIdRef.current;
    if (!targetProjectId) {
      return;
    }
    try {
      const [worktrees, tabs] = await Promise.all([
        listWorktrees(targetProjectId),
        listTabs(targetProjectId),
      ]);
      // `set-tabs` replaces the whole (single-project) tab list, so only apply
      // it if this refresh still targets the selected project — otherwise a
      // slow refresh could clobber a project the user has since switched to.
      if (selectedProjectIdRef.current !== targetProjectId) {
        return;
      }
      dispatch({ type: "set-worktrees", projectId: targetProjectId, worktrees });
      dispatch({ type: "set-tabs", tabs });
    } catch (cause) {
      dispatch({ type: "load-error", error: messageFor(cause) });
    }
  }, []);

  const selectWorktree = useCallback(
    (worktreeId: string | null) => {
      if (!state.selectedProjectId || !worktreeId) {
        return;
      }
      dispatch({ type: "select-worktree", projectId: state.selectedProjectId, worktreeId });
    },
    [state.selectedProjectId],
  );

  const createTerminalTab = useCallback(
    async (worktreeId?: string) => {
      const projectId = state.selectedProjectId;
      const targetWorktreeId =
        worktreeId ?? (projectId ? state.selectedWorktreeByProject[projectId] : undefined);
      if (!projectId || !targetWorktreeId) {
        return;
      }
      try {
        const tab = await createTabCommand(projectId, targetWorktreeId, "terminal", "Shell");
        dispatch({ type: "add-tab", tab });
      } catch (cause) {
        dispatch({ type: "load-error", error: messageFor(cause) });
      }
    },
    [state.selectedProjectId, state.selectedWorktreeByProject],
  );

  const createBrowserTab = useCallback(
    async (worktreeId?: string) => {
      const projectId = state.selectedProjectId;
      const targetWorktreeId =
        worktreeId ?? (projectId ? state.selectedWorktreeByProject[projectId] : undefined);
      if (!projectId || !targetWorktreeId) {
        return;
      }
      try {
        const tab = await createTabCommand(
          projectId,
          targetWorktreeId,
          "browser",
          "New tab",
          BROWSER_START_URL,
        );
        dispatch({ type: "add-tab", tab });
      } catch (cause) {
        dispatch({ type: "load-error", error: messageFor(cause) });
      }
    },
    [state.selectedProjectId, state.selectedWorktreeByProject],
  );

  // Tear down both backends regardless of kind: each is a no-op for the other's
  // tabs, so we don't need to look up the tab's kind on the close path.
  const closeTab = useCallback(async (tabId: string) => {
    terminalManager.dispose(tabId);
    void browserClose(tabId);
    try {
      await closeTabCommand(tabId);
      dispatch({ type: "remove-tab", tabId });
    } catch (cause) {
      dispatch({ type: "load-error", error: messageFor(cause) });
    }
  }, []);

  const renameTerminalTab = useCallback(async (tabId: string, title: string) => {
    try {
      await renameTabCommand(tabId, title);
      dispatch({ type: "rename-tab", tabId, title });
    } catch (cause) {
      dispatch({ type: "load-error", error: messageFor(cause) });
    }
  }, []);

  const setActiveTab = useCallback(
    (tabId: string | null) => {
      const worktreeId = tabId ? state.tabs.find((tab) => tab.id === tabId)?.worktreeId : undefined;
      if (!tabId || !worktreeId) {
        return;
      }
      dispatch({ type: "set-active-tab", worktreeId, tabId });
    },
    [state.tabs],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!state.selectedProjectId) {
      return;
    }
    let cancelled = false;
    async function loadProjectDetails(projectId: string) {
      try {
        const [worktrees, tabs] = await Promise.all([
          listWorktrees(projectId),
          listTabs(projectId),
        ]);
        if (!cancelled) {
          dispatch({ type: "set-worktrees", projectId, worktrees });
          dispatch({ type: "set-tabs", tabs });
        }
      } catch (cause) {
        if (!cancelled) {
          dispatch({ type: "load-error", error: messageFor(cause) });
        }
      }
    }
    void loadProjectDetails(state.selectedProjectId);
    return () => {
      cancelled = true;
    };
  }, [state.selectedProjectId]);

  useEffect(() => {
    for (const project of state.projects) {
      if (project.id in state.icons) {
        continue;
      }
      void projectIcon(project.id).then((icon) =>
        dispatch({ type: "set-icon", projectId: project.id, icon }),
      );
    }
  }, [state.icons, state.projects]);

  // Browser webviews report their page title/URL natively; mirror those into tab
  // state (so the tab strip + address bar update) and persist them for restore.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onBrowserMeta((meta) => {
      if (meta.title !== undefined) {
        dispatch({ type: "rename-tab", tabId: meta.tabId, title: meta.title });
        void renameTabCommand(meta.tabId, meta.title).catch(() => undefined);
      }
      if (meta.url !== undefined) {
        dispatch({ type: "set-tab-url", tabId: meta.tabId, url: meta.url });
        void setTabUrlCommand(meta.tabId, meta.url).catch(() => undefined);
      }
    })
      .then((stop) => (unlisten = stop))
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, []);

  const activeProject =
    state.projects.find((project) => project.id === state.selectedProjectId) ?? null;
  const projectWorktrees = state.selectedProjectId
    ? (state.worktrees[state.selectedProjectId] ?? [])
    : [];
  const selectedWorktreeId = state.selectedProjectId
    ? (state.selectedWorktreeByProject[state.selectedProjectId] ?? null)
    : null;
  const selectedWorktree =
    projectWorktrees.find((worktree) => worktree.id === selectedWorktreeId) ?? null;

  const openSelectedWorktree = useCallback(
    async (editorId?: string | null) => {
      if (!selectedWorktree) {
        return;
      }
      try {
        await openWorktreeCommand(selectedWorktree.path, editorId);
      } catch (cause) {
        dispatch({ type: "load-error", error: messageFor(cause) });
      }
    },
    [selectedWorktree],
  );

  const openWorktreeInEditor = useCallback(
    async (worktreeId: string, editorId?: string | null) => {
      // Walk every project's worktree list; the user might right-click a
      // hidden worktree or one in a sibling project. Cost is trivial.
      const all = Object.values(state.worktrees).flat();
      const target = all.find((worktree) => worktree.id === worktreeId);
      if (!target) {
        return;
      }
      try {
        await openWorktreeCommand(target.path, editorId);
      } catch (cause) {
        dispatch({ type: "load-error", error: messageFor(cause) });
      }
    },
    [state.worktrees],
  );

  const getWorktreeStatus = useCallback(async (worktreeId: string) => {
    return worktreeStatusCommand(worktreeId);
  }, []);

  const deleteWorktree = useCallback(
    async (worktreeId: string, options: { deleteBranch: boolean; force: boolean }) => {
      try {
        await deleteWorktreeCommand(worktreeId, options.deleteBranch, options.force);
        // Optimistically drop the row from local state; the cascade also
        // removes its tabs and any nested child worktrees from SQLite.
        dispatch({ type: "remove-worktree", worktreeId });
      } catch (cause) {
        dispatch({ type: "load-error", error: messageFor(cause) });
        throw cause;
      }
    },
    [],
  );

  const renameWorktree = useCallback(async (worktreeId: string, title: string) => {
    try {
      const updated = await renameWorktreeCommand(worktreeId, title);
      dispatch({ type: "update-worktree", worktree: updated });
    } catch (cause) {
      dispatch({ type: "load-error", error: messageFor(cause) });
    }
  }, []);

  const hideWorktree = useCallback(async (worktreeId: string, hidden: boolean) => {
    try {
      const updated = await setWorktreeHiddenCommand(worktreeId, hidden);
      dispatch({ type: "update-worktree", worktree: updated });
    } catch (cause) {
      dispatch({ type: "load-error", error: messageFor(cause) });
    }
  }, []);

  const visibleTabs = useMemo(
    () => state.tabs.filter((tab) => tab.worktreeId === selectedWorktreeId),
    [state.tabs, selectedWorktreeId],
  );
  const activeTabId = (() => {
    if (!selectedWorktreeId) {
      return null;
    }
    const remembered = state.activeTabByWorktree[selectedWorktreeId];
    if (remembered && visibleTabs.some((tab) => tab.id === remembered)) {
      return remembered;
    }
    return visibleTabs[0]?.id ?? null;
  })();
  const activeTab = visibleTabs.find((tab) => tab.id === activeTabId) ?? null;

  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      if (visibleTabs.length === 0 || !activeTabId || !selectedWorktreeId) {
        return;
      }
      const current = visibleTabs.findIndex((tab) => tab.id === activeTabId);
      const next = (current + direction + visibleTabs.length) % visibleTabs.length;
      dispatch({
        type: "set-active-tab",
        worktreeId: selectedWorktreeId,
        tabId: visibleTabs[next]!.id,
      });
    },
    [visibleTabs, activeTabId, selectedWorktreeId],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      ...state,
      tabs: visibleTabs,
      selectedWorktreeId,
      activeTabId,
      activeProject,
      selectedWorktree,
      activeTab,
      reload,
      refreshProject,
      selectProject,
      selectWorktree,
      createTerminalTab,
      createBrowserTab,
      closeTab,
      renameTerminalTab,
      openSelectedWorktree,
      openWorktreeInEditor,
      cycleTab,
      setActiveTab,
      getWorktreeStatus,
      deleteWorktree,
      renameWorktree,
      hideWorktree,
    }),
    [
      state,
      visibleTabs,
      selectedWorktreeId,
      activeTabId,
      activeProject,
      selectedWorktree,
      activeTab,
      reload,
      refreshProject,
      selectProject,
      selectWorktree,
      createTerminalTab,
      createBrowserTab,
      closeTab,
      renameTerminalTab,
      openSelectedWorktree,
      openWorktreeInEditor,
      cycleTab,
      setActiveTab,
      getWorktreeStatus,
      deleteWorktree,
      renameWorktree,
      hideWorktree,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** Accesses workspace metadata state and high-level actions. */
export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used inside WorkspaceProvider");
  }
  return context;
}

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
