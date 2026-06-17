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

import type {
  DiffSide,
  Project,
  ProjectIcon,
  Tab,
  Worktree,
  WorktreeStatus,
} from "@pragma/constants";

import { toast } from "sonner";

import { BROWSER_START_URL } from "@/lib/browser-manager";
import { basename } from "@/lib/path";
import { defaultTabTitle } from "@/lib/tab-title";
import { terminalManager } from "@/lib/terminal-manager";
import {
  browserClose,
  clearSplitLayout as clearSplitLayoutCommand,
  closeTab as closeTabCommand,
  createTab as createTabCommand,
  deleteWorktree as deleteWorktreeCommand,
  getActiveSelection,
  listProjects,
  listSplits,
  listTabs,
  listWorktrees,
  onBrowserFocusRequest,
  onBrowserMeta,
  onMenuAction,
  openWorktree as openWorktreeCommand,
  projectIcon,
  renameTab as renameTabCommand,
  renameWorktree as renameWorktreeCommand,
  restartDaemon as restartDaemonCommand,
  setActiveSelection,
  setSplitLayout as setSplitLayoutCommand,
  setTabTitle as setTabTitleCommand,
  setTabUrl as setTabUrlCommand,
  setWorktreeHidden as setWorktreeHiddenCommand,
  worktreeStatus as worktreeStatusCommand,
} from "@/lib/tauri";
import type { SplitLayout } from "@/lib/tauri";

export type SplitDirection = "horizontal" | "vertical";
export type SplitPlacement = "before" | "after";

export interface SplitPaneNode {
  kind: "pane";
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface SplitGroupNode {
  kind: "split";
  id: string;
  direction: SplitDirection;
  children: [SplitLayoutNode, SplitLayoutNode];
}

export type SplitLayoutNode = SplitPaneNode | SplitGroupNode;

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
  /** Nested, frontend-only split layout per worktree. Panes reference tab IDs. */
  splitRootByWorktree: Record<string, SplitLayoutNode>;
  /** Focused split pane per worktree; tab shortcuts apply to this pane. */
  focusedPaneByWorktree: Record<string, string>;
  icons: Record<string, ProjectIcon | null>;
  loading: boolean;
  error: string | null;
}

type WorkspaceAction =
  | { type: "load-start" }
  | { type: "load-error"; error: string }
  | { type: "set-projects"; projects: Project[] }
  | {
      type: "hydrate-selection";
      projectId: string | null;
      worktreeByProject: Record<string, string>;
    }
  | { type: "set-worktrees"; projectId: string; worktrees: Worktree[] }
  | { type: "set-tabs"; tabs: Tab[] }
  | { type: "set-splits"; worktreeRoots: Record<string, SplitLayoutNode> }
  | { type: "select-project"; projectId: string | null }
  | { type: "select-worktree"; projectId: string; worktreeId: string }
  | { type: "set-active-tab"; worktreeId: string; tabId: string }
  | { type: "focus-pane"; worktreeId: string; paneId: string }
  | { type: "set-pane-active-tab"; worktreeId: string; paneId: string; tabId: string }
  | {
      type: "split-pane";
      worktreeId: string;
      paneId: string | null;
      tabId: string;
      direction: SplitDirection;
      placement: SplitPlacement;
    }
  | { type: "move-tab-to-pane"; worktreeId: string; paneId: string; tabId: string }
  | { type: "add-tab"; tab: Tab }
  | { type: "add-tab-to-pane"; tab: Tab; paneId: string }
  | { type: "remove-tab"; tabId: string }
  | { type: "rename-tab"; tabId: string; title: string }
  | { type: "set-auto-title"; tabId: string; title: string }
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
  splitRoot: SplitLayoutNode | null;
  focusedPaneId: string | null;
  reload: () => Promise<void>;
  refreshProject: (projectId?: string | null) => Promise<void>;
  selectProject: (projectId: string | null) => Promise<void>;
  selectWorktree: (worktreeId: string | null) => void;
  createTerminalTab: (worktreeId?: string) => Promise<void>;
  createBrowserTab: (worktreeId?: string) => Promise<void>;
  /** Create a new tab inside a specific split pane (the pane's "+" button). */
  createTabInPane: (paneId: string, kind: "terminal" | "browser") => Promise<void>;
  /** Opens (or focuses) an editor tab for a worktree-relative file path. */
  openFileTab: (path: string, opts?: { paneId?: string }) => Promise<void>;
  /** Opens (or focuses) a read-only diff tab for a worktree-relative file path. */
  openDiffTab: (path: string, side: DiffSide, opts?: { paneId?: string }) => Promise<void>;
  /** Opens (or focuses) the read-only daemon-log tab (Troubleshooting menu). */
  openDaemonLogTab: () => Promise<void>;
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
  focusPane: (paneId: string) => void;
  setPaneActiveTab: (paneId: string, tabId: string) => void;
  splitActivePane: (tabId: string, direction: SplitDirection) => void;
  splitTabAtPane: (
    tabId: string,
    paneId: string,
    direction: SplitDirection,
    placement: SplitPlacement,
  ) => void;
  moveTabToPane: (tabId: string, paneId: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const TERMINAL_TITLE_FLUSH_MS = 100;
const TERMINAL_TAB_ID_SEPARATOR = "\u0000";

const initialState: WorkspaceState = {
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

let nextSplitNode = 0;

function splitNodeId(prefix: "pane" | "split"): string {
  nextSplitNode += 1;
  return `${prefix}-${nextSplitNode}`;
}

/**
 * Advances the node-id counter past any numeric ids found in a restored layout
 * so freshly generated pane/split ids never collide with persisted ones after a
 * restart (the counter otherwise resets to 0 each launch).
 */
function reserveSplitNodeIds(node: SplitLayoutNode): void {
  const match = /-(\d+)$/.exec(node.id);
  if (match) {
    nextSplitNode = Math.max(nextSplitNode, Number(match[1]));
  }
  if (node.kind === "split") {
    reserveSplitNodeIds(node.children[0]);
    reserveSplitNodeIds(node.children[1]);
  }
}

/**
 * Parses persisted split records into a worktree → layout map, reserving their
 * node ids. Corrupt rows are skipped rather than failing the whole load.
 */
function parseStoredSplits(records: SplitLayout[]): Record<string, SplitLayoutNode> {
  const roots: Record<string, SplitLayoutNode> = {};
  for (const record of records) {
    try {
      const root = JSON.parse(record.layout) as SplitLayoutNode;
      reserveSplitNodeIds(root);
      roots[record.worktreeId] = root;
    } catch {
      // Skip a corrupt layout blob; the worktree falls back to a single pane.
    }
  }
  return roots;
}

/**
 * Persisted active-selection shape, owned by the frontend (Rust stores the JSON
 * verbatim). `projectId` is the last active project; `worktreeByProject` maps a
 * project id to its last active worktree so switching away and back — even
 * across restarts — returns to the worktree the user left off on.
 */
interface PersistedSelection {
  projectId: string | null;
  worktreeByProject: Record<string, string>;
}

function serializeSelection(
  projectId: string | null,
  worktreeByProject: Record<string, string>,
): string {
  return JSON.stringify({ projectId, worktreeByProject });
}

/** Parses a persisted selection blob; returns null on a corrupt/missing one. */
function parseSelection(raw: string | null): PersistedSelection | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSelection>;
    const projectId = typeof parsed.projectId === "string" ? parsed.projectId : null;
    const worktreeByProject: Record<string, string> = {};
    if (parsed.worktreeByProject && typeof parsed.worktreeByProject === "object") {
      for (const [key, value] of Object.entries(parsed.worktreeByProject)) {
        if (typeof value === "string") {
          worktreeByProject[key] = value;
        }
      }
    }
    return { projectId, worktreeByProject };
  } catch {
    // A corrupt blob is treated as no selection; the user lands on the first
    // project's main worktree, the same as a first launch.
    return null;
  }
}

function defaultPaneId(worktreeId: string): string {
  return `pane-default-${worktreeId}`;
}

function uniqueTabIds(tabIds: string[]): string[] {
  return [...new Set(tabIds)];
}

function createPane(tabIds: string[], activeTabId?: string | null, id = splitNodeId("pane")) {
  const uniqueIds = uniqueTabIds(tabIds);
  return {
    kind: "pane" as const,
    id,
    tabIds: uniqueIds,
    activeTabId:
      activeTabId && uniqueIds.includes(activeTabId) ? activeTabId : (uniqueIds[0] ?? null),
  };
}

function initialRootForWorktree(
  worktreeId: string,
  tabs: Tab[],
  activeTabId?: string | null,
): SplitPaneNode | null {
  const tabIds = tabs.filter((tab) => tab.worktreeId === worktreeId).map((tab) => tab.id);
  if (tabIds.length === 0) {
    return null;
  }
  return createPane(tabIds, activeTabId, defaultPaneId(worktreeId));
}

function findPane(
  node: SplitLayoutNode | null | undefined,
  predicate: (pane: SplitPaneNode) => boolean,
): SplitPaneNode | null {
  if (!node) {
    return null;
  }
  if (node.kind === "pane") {
    return predicate(node) ? node : null;
  }
  return findPane(node.children[0], predicate) ?? findPane(node.children[1], predicate);
}

function firstPane(node: SplitLayoutNode | null | undefined): SplitPaneNode | null {
  return findPane(node, () => true);
}

function paneContainingTab(
  node: SplitLayoutNode | null | undefined,
  tabId: string,
): SplitPaneNode | null {
  return findPane(node, (pane) => pane.tabIds.includes(tabId));
}

function tabIdsInNode(node: SplitLayoutNode | null | undefined): Set<string> {
  const tabIds = new Set<string>();
  findPane(node, (pane) => {
    for (const tabId of pane.tabIds) {
      tabIds.add(tabId);
    }
    return false;
  });
  return tabIds;
}

function paneById(node: SplitLayoutNode | null | undefined, paneId: string): SplitPaneNode | null {
  return findPane(node, (pane) => pane.id === paneId);
}

function replacePane(
  node: SplitLayoutNode,
  paneId: string,
  replace: (pane: SplitPaneNode) => SplitLayoutNode,
): SplitLayoutNode {
  if (node.kind === "pane") {
    return node.id === paneId ? replace(node) : node;
  }
  return {
    ...node,
    children: [
      replacePane(node.children[0], paneId, replace),
      replacePane(node.children[1], paneId, replace),
    ],
  };
}

function removeTabFromNode(node: SplitLayoutNode, tabId: string): SplitLayoutNode | null {
  if (node.kind === "pane") {
    if (!node.tabIds.includes(tabId)) {
      return node;
    }
    const tabIds = node.tabIds.filter((id) => id !== tabId);
    if (tabIds.length === 0) {
      return null;
    }
    return createPane(
      tabIds,
      node.activeTabId === tabId ? tabIds.at(-1) : node.activeTabId,
      node.id,
    );
  }
  const first = removeTabFromNode(node.children[0], tabId);
  const second = removeTabFromNode(node.children[1], tabId);
  if (first && second) {
    return { ...node, children: [first, second] };
  }
  return first ?? second;
}

function reconcileNode(node: SplitLayoutNode, validTabIds: Set<string>): SplitLayoutNode | null {
  if (node.kind === "pane") {
    const tabIds = node.tabIds.filter((tabId) => validTabIds.has(tabId));
    if (tabIds.length === 0) {
      return null;
    }
    return createPane(tabIds, node.activeTabId, node.id);
  }
  const first = reconcileNode(node.children[0], validTabIds);
  const second = reconcileNode(node.children[1], validTabIds);
  if (first && second) {
    return { ...node, children: [first, second] };
  }
  return first ?? second;
}

function normalizeRoot(
  root: SplitLayoutNode | undefined,
  worktreeId: string,
  tabs: Tab[],
  activeTabId?: string | null,
): SplitLayoutNode | null {
  const tabIds = tabs.filter((tab) => tab.worktreeId === worktreeId).map((tab) => tab.id);
  if (tabIds.length === 0) {
    return null;
  }
  if (!root) {
    return initialRootForWorktree(worktreeId, tabs, activeTabId);
  }
  const reconciled = reconcileNode(root, new Set(tabIds));
  if (!reconciled) {
    return initialRootForWorktree(worktreeId, tabs, activeTabId);
  }
  // A single-pane root is the implicit "all tabs share one pane" state, so fold
  // any newly loaded tabs into it. Tabs missing from a real split intentionally
  // stay out of the layout — they are normal top-bar tabs, not split members.
  if (reconciled.kind === "pane") {
    const existingIds = new Set(reconciled.tabIds);
    const missingIds = tabIds.filter((id) => !existingIds.has(id));
    if (missingIds.length > 0) {
      const mergedIds = [...reconciled.tabIds, ...missingIds];
      return createPane(
        mergedIds,
        activeTabId && mergedIds.includes(activeTabId) ? activeTabId : reconciled.activeTabId,
        reconciled.id,
      );
    }
  }
  return reconciled;
}

function rootsForTabs(
  roots: Record<string, SplitLayoutNode>,
  tabs: Tab[],
): Record<string, SplitLayoutNode> {
  // `tabs` is a single project's snapshot, so only reconcile roots for worktrees
  // it actually covers. Roots for worktrees in *other* projects must be left
  // untouched — dropping them here is what lost split layouts when switching
  // projects (and would also trigger the persistence layer to clear them).
  const worktreeIdsInTabs = new Set(tabs.map((tab) => tab.worktreeId));
  const nextRoots: Record<string, SplitLayoutNode> = {};
  for (const [worktreeId, root] of Object.entries(roots)) {
    if (!worktreeIdsInTabs.has(worktreeId)) {
      nextRoots[worktreeId] = root;
      continue;
    }
    const normalized = normalizeRoot(root, worktreeId, tabs);
    if (normalized) {
      nextRoots[worktreeId] = normalized;
    }
  }
  return nextRoots;
}

function focusForRoot(
  root: SplitLayoutNode | null | undefined,
  focusedPaneId?: string | null,
): SplitPaneNode | null {
  return (focusedPaneId ? paneById(root, focusedPaneId) : null) ?? firstPane(root);
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "load-start":
      return { ...state, loading: true, error: null };
    case "load-error":
      return { ...state, loading: false, error: action.error };
    case "set-projects": {
      // Keep the already-selected (hydrated or user-chosen) project when it is
      // still in the loaded list; otherwise fall back to the first project. The
      // guard is what makes a persisted selection survive a restart while still
      // recovering if that project was deleted in another session.
      const persisted = state.selectedProjectId;
      const selectedProjectId =
        persisted && action.projects.some((project) => project.id === persisted)
          ? persisted
          : (action.projects[0]?.id ?? null);
      return { ...state, projects: action.projects, selectedProjectId, loading: false };
    }
    case "hydrate-selection":
      // Seeds the active project + per-project worktree map from the persisted
      // selection before `set-projects` runs, so the project-load effect lands
      // on the remembered project/worktree instead of the first/main one.
      return {
        ...state,
        selectedProjectId: action.projectId,
        selectedWorktreeByProject: { ...action.worktreeByProject },
      };
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
      return {
        ...state,
        tabs: action.tabs,
        splitRootByWorktree: rootsForTabs(state.splitRootByWorktree, action.tabs),
      };
    case "set-splits": {
      // Merge persisted layouts for the loaded project's worktrees over whatever
      // is in memory, reconciling each against the current tabs (a tab may have
      // been closed in another window/session). Other worktrees are untouched.
      const splitRootByWorktree = { ...state.splitRootByWorktree };
      for (const [worktreeId, root] of Object.entries(action.worktreeRoots)) {
        const normalized = normalizeRoot(
          root,
          worktreeId,
          state.tabs,
          state.activeTabByWorktree[worktreeId],
        );
        if (normalized) {
          splitRootByWorktree[worktreeId] = normalized;
        } else {
          delete splitRootByWorktree[worktreeId];
        }
      }
      return { ...state, splitRootByWorktree };
    }
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
    case "set-active-tab": {
      const root = state.splitRootByWorktree[action.worktreeId];
      const pane = paneContainingTab(root, action.tabId);
      return {
        ...state,
        activeTabByWorktree: {
          ...state.activeTabByWorktree,
          [action.worktreeId]: action.tabId,
        },
        splitRootByWorktree:
          root && pane
            ? {
                ...state.splitRootByWorktree,
                [action.worktreeId]: replacePane(root, pane.id, (item) =>
                  createPane(item.tabIds, action.tabId, item.id),
                ),
              }
            : state.splitRootByWorktree,
        focusedPaneByWorktree: pane
          ? { ...state.focusedPaneByWorktree, [action.worktreeId]: pane.id }
          : Object.fromEntries(
              Object.entries(state.focusedPaneByWorktree).filter(
                ([worktreeId]) => worktreeId !== action.worktreeId,
              ),
            ),
      };
    }
    case "focus-pane": {
      const root = normalizeRoot(
        state.splitRootByWorktree[action.worktreeId],
        action.worktreeId,
        state.tabs,
        state.activeTabByWorktree[action.worktreeId],
      );
      const pane = paneById(root, action.paneId);
      if (!root || !pane) {
        return state;
      }
      return {
        ...state,
        activeTabByWorktree: pane.activeTabId
          ? { ...state.activeTabByWorktree, [action.worktreeId]: pane.activeTabId }
          : state.activeTabByWorktree,
        splitRootByWorktree: {
          ...state.splitRootByWorktree,
          [action.worktreeId]: root,
        },
        focusedPaneByWorktree: {
          ...state.focusedPaneByWorktree,
          [action.worktreeId]: action.paneId,
        },
      };
    }
    case "set-pane-active-tab": {
      const root = normalizeRoot(
        state.splitRootByWorktree[action.worktreeId],
        action.worktreeId,
        state.tabs,
        state.activeTabByWorktree[action.worktreeId],
      );
      const pane = paneById(root, action.paneId);
      if (!root || !pane?.tabIds.includes(action.tabId)) {
        return state;
      }
      return {
        ...state,
        activeTabByWorktree: {
          ...state.activeTabByWorktree,
          [action.worktreeId]: action.tabId,
        },
        splitRootByWorktree: {
          ...state.splitRootByWorktree,
          [action.worktreeId]: replacePane(root, action.paneId, (item) =>
            createPane(item.tabIds, action.tabId, item.id),
          ),
        },
        focusedPaneByWorktree: {
          ...state.focusedPaneByWorktree,
          [action.worktreeId]: action.paneId,
        },
      };
    }
    case "split-pane": {
      const root = normalizeRoot(
        state.splitRootByWorktree[action.worktreeId],
        action.worktreeId,
        state.tabs,
        state.activeTabByWorktree[action.worktreeId],
      );
      if (!root) {
        return state;
      }
      const selectedTab = state.tabs.find(
        (tab) => tab.id === action.tabId && tab.worktreeId === action.worktreeId,
      );
      if (!selectedTab) {
        return state;
      }
      const sourcePane =
        (action.paneId ? paneById(root, action.paneId) : null) ??
        focusForRoot(root, state.focusedPaneByWorktree[action.worktreeId]);
      if (!sourcePane) {
        return state;
      }
      // When the worktree is not yet split the root is one implicit pane holding
      // every tab, but only the displayed (active) tab is really "shown" — so the
      // new split is [activeTab | droppedTab] and the other tabs fall back to
      // being normal top-bar tabs. Inside a real split the source pane keeps its
      // own tabs.
      const implicit = root.kind === "pane";
      const keepIds = (
        implicit ? (sourcePane.activeTabId ? [sourcePane.activeTabId] : []) : sourcePane.tabIds
      ).filter((id) => id !== action.tabId);
      if (keepIds.length === 0) {
        return state;
      }
      const targetPane = createPane([action.tabId], action.tabId);
      const currentPane = createPane(
        keepIds,
        keepIds.includes(sourcePane.activeTabId ?? "") ? sourcePane.activeTabId : keepIds.at(-1),
        sourcePane.id,
      );
      const splitNode: SplitLayoutNode = {
        kind: "split",
        id: splitNodeId("split"),
        direction: action.direction,
        children:
          action.placement === "after" ? [currentPane, targetPane] : [targetPane, currentPane],
      };
      const nextRoot = implicit
        ? splitNode
        : replacePane(
            removeTabFromNode(root, action.tabId) ?? root,
            sourcePane.id,
            () => splitNode,
          );
      return {
        ...state,
        activeTabByWorktree: {
          ...state.activeTabByWorktree,
          [action.worktreeId]: action.tabId,
        },
        splitRootByWorktree: {
          ...state.splitRootByWorktree,
          [action.worktreeId]: nextRoot,
        },
        focusedPaneByWorktree: {
          ...state.focusedPaneByWorktree,
          [action.worktreeId]: targetPane.id,
        },
      };
    }
    case "move-tab-to-pane": {
      const root = normalizeRoot(
        state.splitRootByWorktree[action.worktreeId],
        action.worktreeId,
        state.tabs,
        state.activeTabByWorktree[action.worktreeId],
      );
      const selectedTab = state.tabs.find(
        (tab) => tab.id === action.tabId && tab.worktreeId === action.worktreeId,
      );
      if (!root || !selectedTab) {
        return state;
      }
      const withoutMoved = removeTabFromNode(root, action.tabId) ?? root;
      const targetPane = paneById(withoutMoved, action.paneId) ?? firstPane(withoutMoved);
      if (!targetPane) {
        return state;
      }
      const nextRoot = replacePane(withoutMoved, targetPane.id, (pane) =>
        createPane([...pane.tabIds, action.tabId], action.tabId, pane.id),
      );
      return {
        ...state,
        activeTabByWorktree: {
          ...state.activeTabByWorktree,
          [action.worktreeId]: action.tabId,
        },
        splitRootByWorktree: {
          ...state.splitRootByWorktree,
          [action.worktreeId]: nextRoot,
        },
        focusedPaneByWorktree: {
          ...state.focusedPaneByWorktree,
          [action.worktreeId]: targetPane.id,
        },
      };
    }
    case "add-tab": {
      return {
        ...state,
        tabs: [...state.tabs, action.tab],
        activeTabByWorktree: {
          ...state.activeTabByWorktree,
          [action.tab.worktreeId]: action.tab.id,
        },
      };
    }
    case "add-tab-to-pane": {
      const { tab, paneId } = action;
      const tabs = [...state.tabs, tab];
      const activeTabByWorktree = {
        ...state.activeTabByWorktree,
        [tab.worktreeId]: tab.id,
      };
      const root = state.splitRootByWorktree[tab.worktreeId];
      const pane = paneById(root, paneId);
      // If the pane vanished, fall back to a normal top-bar tab.
      if (!root || !pane) {
        return { ...state, tabs, activeTabByWorktree };
      }
      return {
        ...state,
        tabs,
        activeTabByWorktree,
        splitRootByWorktree: {
          ...state.splitRootByWorktree,
          [tab.worktreeId]: replacePane(root, paneId, (item) =>
            createPane([...item.tabIds, tab.id], tab.id, item.id),
          ),
        },
        focusedPaneByWorktree: {
          ...state.focusedPaneByWorktree,
          [tab.worktreeId]: paneId,
        },
      };
    }
    case "remove-tab": {
      const removed = state.tabs.find((tab) => tab.id === action.tabId);
      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
      let activeTabByWorktree = state.activeTabByWorktree;
      let splitRootByWorktree = state.splitRootByWorktree;
      let focusedPaneByWorktree = state.focusedPaneByWorktree;
      let sourcePane: SplitPaneNode | null = null;
      let nextRoot: SplitLayoutNode | null = null;
      if (removed) {
        const root = state.splitRootByWorktree[removed.worktreeId];
        if (root) {
          sourcePane = paneContainingTab(root, action.tabId);
          nextRoot = removeTabFromNode(root, action.tabId);
          splitRootByWorktree = { ...splitRootByWorktree };
          focusedPaneByWorktree = { ...focusedPaneByWorktree };
          if (nextRoot) {
            const focusedPane = focusForRoot(nextRoot, focusedPaneByWorktree[removed.worktreeId]);
            splitRootByWorktree[removed.worktreeId] = nextRoot;
            if (focusedPane) {
              focusedPaneByWorktree[removed.worktreeId] = focusedPane.id;
            }
          } else {
            delete splitRootByWorktree[removed.worktreeId];
            delete focusedPaneByWorktree[removed.worktreeId];
          }
        }
      }
      if (removed && state.activeTabByWorktree[removed.worktreeId] === action.tabId) {
        const nextPane = sourcePane && nextRoot ? paneById(nextRoot, sourcePane.id) : null;
        const restoredTabIds = nextRoot ? tabIdsInNode(nextRoot) : new Set<string>();
        const fallback =
          nextPane?.activeTabId ??
          tabs.findLast(
            (tab) => tab.worktreeId === removed.worktreeId && !restoredTabIds.has(tab.id),
          )?.id ??
          tabs.findLast((tab) => tab.worktreeId === removed.worktreeId)?.id;
        activeTabByWorktree = { ...activeTabByWorktree };
        if (fallback) {
          activeTabByWorktree[removed.worktreeId] = fallback;
        } else {
          delete activeTabByWorktree[removed.worktreeId];
        }
      }
      return { ...state, tabs, activeTabByWorktree, splitRootByWorktree, focusedPaneByWorktree };
    }
    case "rename-tab":
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.tabId ? { ...tab, title: action.title, userRenamed: true } : tab,
        ),
      };
    case "set-auto-title":
      // Shell/browser-emitted title. Respects `userRenamed` so a user-typed
      // rename can never be silently clobbered by a `precmd`/`PROMPT_COMMAND`
      // title push or a stray `<title>` update from a browser webview. A blank
      // push (e.g. opencode clearing the title on exit) falls back to the kind's
      // default so the tab never goes nameless.
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.tabId && !tab.userRenamed
            ? { ...tab, title: action.title.trim() || defaultTabTitle(tab.kind) }
            : tab,
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
      // Drop the worktree's split layout/focus too (SQLite cascades the `splits`
      // row via the worktree FK; this keeps the in-memory snapshot in sync).
      const splitRootByWorktree = { ...state.splitRootByWorktree };
      delete splitRootByWorktree[action.worktreeId];
      const focusedPaneByWorktree = { ...state.focusedPaneByWorktree };
      delete focusedPaneByWorktree[action.worktreeId];
      return {
        ...state,
        worktrees,
        selectedWorktreeByProject,
        tabs,
        splitRootByWorktree,
        focusedPaneByWorktree,
      };
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
  const tabsRef = useRef(state.tabs);
  tabsRef.current = state.tabs;

  // Latest selected project, readable from async callbacks without re-creating
  // them on every selection change.
  const selectedProjectIdRef = useRef(state.selectedProjectId);
  selectedProjectIdRef.current = state.selectedProjectId;

  // Hydration / persistence bookkeeping for the active selection (last active
  // project + per-project last active worktree). `didHydrateRef` flips true
  // once the mount-time `reload` has rehydrated from SQLite; the persist effect
  // stays inert until then so the initial empty state isn't written back over a
  // saved selection. `lastPersistedRef` holds the last JSON string written so
  // the effect can skip a no-op write (and so the first post-hydration run,
  // which reproduces the just-loaded value, doesn't re-write it).
  const didHydrateRef = useRef(false);
  const lastPersistedRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    dispatch({ type: "load-start" });
    try {
      // Only the mount-time reload rehydrates the selection. Subsequent
      // reloads (after add/clone) just refresh the project list — the
      // in-memory selection is already authoritative, and re-reading stale
      // backend state could race an in-flight persist write.
      if (didHydrateRef.current) {
        const projects = await listProjects();
        dispatch({ type: "set-projects", projects });
        return;
      }
      const [projects, rawSelection] = await Promise.all([listProjects(), getActiveSelection()]);
      const selection = parseSelection(rawSelection);
      if (selection) {
        dispatch({
          type: "hydrate-selection",
          projectId: selection.projectId,
          worktreeByProject: selection.worktreeByProject,
        });
        lastPersistedRef.current = serializeSelection(
          selection.projectId,
          selection.worktreeByProject,
        );
      } else {
        lastPersistedRef.current = null;
      }
      // `set-projects` validates the hydrated project id against the loaded
      // list and falls back to the first project if it was deleted elsewhere.
      dispatch({ type: "set-projects", projects });
      didHydrateRef.current = true;
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
      const [worktrees, tabs, splits] = await Promise.all([
        listWorktrees(targetProjectId),
        listTabs(targetProjectId),
        listSplits(targetProjectId),
      ]);
      // `set-tabs` replaces the whole (single-project) tab list, so only apply
      // it if this refresh still targets the selected project — otherwise a
      // slow refresh could clobber a project the user has since switched to.
      if (selectedProjectIdRef.current !== targetProjectId) {
        return;
      }
      dispatch({ type: "set-worktrees", projectId: targetProjectId, worktrees });
      dispatch({ type: "set-tabs", tabs });
      dispatch({ type: "set-splits", worktreeRoots: parseStoredSplits(splits) });
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

  // Shared tab-creation path. When `paneId` is set the new tab lands inside that
  // split pane; otherwise it becomes a normal top-bar tab.
  const createTab = useCallback(
    async (kind: "terminal" | "browser", paneId: string | null, worktreeId?: string) => {
      const projectId = state.selectedProjectId;
      const targetWorktreeId =
        worktreeId ?? (projectId ? state.selectedWorktreeByProject[projectId] : undefined);
      if (!projectId || !targetWorktreeId) {
        return;
      }
      try {
        const tab =
          kind === "terminal"
            ? await createTabCommand(
                projectId,
                targetWorktreeId,
                "terminal",
                defaultTabTitle("terminal"),
              )
            : await createTabCommand(
                projectId,
                targetWorktreeId,
                "browser",
                defaultTabTitle("browser"),
                BROWSER_START_URL,
              );
        dispatch(paneId ? { type: "add-tab-to-pane", tab, paneId } : { type: "add-tab", tab });
      } catch (cause) {
        dispatch({ type: "load-error", error: messageFor(cause) });
      }
    },
    [state.selectedProjectId, state.selectedWorktreeByProject],
  );

  const createTerminalTab = useCallback(
    (worktreeId?: string) => createTab("terminal", null, worktreeId),
    [createTab],
  );

  const createBrowserTab = useCallback(
    (worktreeId?: string) => createTab("browser", null, worktreeId),
    [createTab],
  );

  const createTabInPane = useCallback(
    (paneId: string, kind: "terminal" | "browser") => createTab(kind, paneId),
    [createTab],
  );

  // Shared opener for editor/diff tabs. Both dedupe against the active worktree's
  // existing tabs (a file path is worktree-relative) before creating a new one.
  const openLocatorTab = useCallback(
    async (
      kind: "editor" | "diff",
      path: string,
      side: DiffSide | null,
      paneId: string | undefined,
    ) => {
      const projectId = state.selectedProjectId;
      const worktreeId = projectId ? state.selectedWorktreeByProject[projectId] : undefined;
      if (!projectId || !worktreeId) {
        return;
      }
      const existing = state.tabs.find(
        (tab) =>
          tab.kind === kind &&
          tab.worktreeId === worktreeId &&
          tab.filePath === path &&
          tab.diffSide === side,
      );
      if (existing) {
        dispatch({ type: "set-active-tab", worktreeId, tabId: existing.id });
        return;
      }
      try {
        const tab = await createTabCommand(
          projectId,
          worktreeId,
          kind,
          basename(path),
          undefined,
          path,
          side,
        );
        dispatch(paneId ? { type: "add-tab-to-pane", tab, paneId } : { type: "add-tab", tab });
      } catch (cause) {
        dispatch({ type: "load-error", error: messageFor(cause) });
      }
    },
    [state.selectedProjectId, state.selectedWorktreeByProject, state.tabs],
  );

  const openFileTab = useCallback(
    (path: string, opts?: { paneId?: string }) =>
      openLocatorTab("editor", path, null, opts?.paneId),
    [openLocatorTab],
  );

  const openDiffTab = useCallback(
    (path: string, side: DiffSide, opts?: { paneId?: string }) =>
      openLocatorTab("diff", path, side, opts?.paneId),
    [openLocatorTab],
  );

  // Opens (or focuses) the read-only daemon-log tab. The daemon is global, so a
  // single log tab per project is enough — dedupe by kind, hosting it in the
  // active worktree (its content is not worktree-scoped).
  const openDaemonLogTab = useCallback(async () => {
    const projectId = state.selectedProjectId;
    const worktreeId = projectId ? state.selectedWorktreeByProject[projectId] : undefined;
    if (!projectId || !worktreeId) {
      return;
    }
    const existing = state.tabs.find((tab) => tab.kind === "log");
    if (existing) {
      dispatch({ type: "set-active-tab", worktreeId: existing.worktreeId, tabId: existing.id });
      return;
    }
    try {
      const tab = await createTabCommand(projectId, worktreeId, "log", defaultTabTitle("log"));
      dispatch({ type: "add-tab", tab });
    } catch (cause) {
      dispatch({ type: "load-error", error: messageFor(cause) });
    }
  }, [state.selectedProjectId, state.selectedWorktreeByProject, state.tabs]);

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

  // Latest `setActiveTab`, readable from event listeners without re-subscribing.
  const setActiveTabRef = useRef(setActiveTab);
  setActiveTabRef.current = setActiveTab;

  // Runs a Troubleshooting-menu action: restart the daemon (with toast feedback)
  // or open the daemon-log tab. Kept in a ref so the listener subscribes once.
  const handleMenuAction = useCallback(
    async (action: "troubleshooting.restart-daemon" | "troubleshooting.open-daemon-logs") => {
      if (action === "troubleshooting.open-daemon-logs") {
        await openDaemonLogTab();
        return;
      }
      const pending = toast.loading("Restarting daemon…");
      try {
        await restartDaemonCommand();
        toast.success("Daemon restarted", { id: pending });
      } catch (cause) {
        toast.error(messageFor(cause), { id: pending });
      }
    },
    [openDaemonLogTab],
  );
  const handleMenuActionRef = useRef(handleMenuAction);
  handleMenuActionRef.current = handleMenuAction;

  // Forward native Troubleshooting-menu clicks to the handler. Subscribe once;
  // the ref keeps the latest handler so we never re-listen as state changes.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onMenuAction((action) => void handleMenuActionRef.current(action))
      .then((stop) => (unlisten = stop))
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, []);

  const terminalTabIdsKey = useMemo(
    () =>
      state.tabs
        .filter((tab) => tab.kind === "terminal")
        .map((tab) => tab.id)
        .join(TERMINAL_TAB_ID_SEPARATOR),
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
        const [worktrees, tabs, splits] = await Promise.all([
          listWorktrees(projectId),
          listTabs(projectId),
          listSplits(projectId),
        ]);
        if (!cancelled) {
          dispatch({ type: "set-worktrees", projectId, worktrees });
          dispatch({ type: "set-tabs", tabs });
          dispatch({ type: "set-splits", worktreeRoots: parseStoredSplits(splits) });
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
  // Browser titles are auto-titles (the page is the source of truth) and route
  // through the `set-auto-title` action so they can never flip `userRenamed`.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onBrowserMeta((meta) => {
      if (meta.title !== undefined) {
        const next = meta.title.trim() || defaultTabTitle("browser");
        dispatch({ type: "set-auto-title", tabId: meta.tabId, title: next });
        void setTabTitleCommand(meta.tabId, next).catch(() => undefined);
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

  // Browser webviews live as native overlays, so clicks on the page don't reach
  // React. Listen for focus requests injected into each browser page and move
  // split-pane focus to the corresponding tab.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onBrowserFocusRequest((request) => setActiveTabRef.current(request.tabId))
      .then((stop) => (unlisten = stop))
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, []);

  // Terminals pipe OSC 0/2 title updates through the non-React
  // `terminalManager` registry. Subscribe once per terminal tab id, then
  // coalesce noisy title streams before touching React state; otherwise TUIs
  // that emit repeated OSC titles can force the whole workspace/sidebar tree to
  // re-render during terminal output, which is especially visible in projects
  // with many worktrees.
  useEffect(() => {
    const unsubscribes: Array<() => void> = [];
    const pendingTitles = new Map<string, string>();
    const flushTimers = new Map<string, number>();
    const lastAppliedTitles = new Map<string, string>();
    const tabIds = terminalTabIdsKey ? terminalTabIdsKey.split(TERMINAL_TAB_ID_SEPARATOR) : [];
    for (const tabId of tabIds) {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (tab) {
        lastAppliedTitles.set(tabId, tab.title?.trim() || defaultTabTitle("terminal"));
      }
      const off = terminalManager.onTitle(tabId, (title) => {
        const next = title.trim() || defaultTabTitle("terminal");
        if (lastAppliedTitles.get(tabId) === next) {
          return;
        }
        pendingTitles.set(tabId, next);
        if (flushTimers.has(tabId)) {
          return;
        }
        const timer = window.setTimeout(() => {
          flushTimers.delete(tabId);
          const pending = pendingTitles.get(tabId);
          pendingTitles.delete(tabId);
          if (!pending || lastAppliedTitles.get(tabId) === pending) {
            return;
          }
          const currentTab = tabsRef.current.find((item) => item.id === tabId);
          if (!currentTab || currentTab.kind !== "terminal" || currentTab.userRenamed) {
            return;
          }
          const currentTitle = currentTab.title?.trim() || defaultTabTitle("terminal");
          if (currentTitle === pending) {
            lastAppliedTitles.set(tabId, pending);
            return;
          }
          lastAppliedTitles.set(tabId, pending);
          dispatch({ type: "set-auto-title", tabId, title: pending });
          void setTabTitleCommand(tabId, pending).catch(() => undefined);
        }, TERMINAL_TITLE_FLUSH_MS);
        flushTimers.set(tabId, timer);
      });
      unsubscribes.push(off);
    }
    return () => {
      for (const timer of flushTimers.values()) {
        window.clearTimeout(timer);
      }
      for (const off of unsubscribes) {
        off();
      }
    };
  }, [terminalTabIdsKey]);

  // Persist split layouts so they survive project switches and app restarts,
  // mirroring how tabs persist. Only real splits are stored; a worktree that
  // collapses back to a single pane clears its row. `persistedSplitsRef` tracks
  // what we've already written so each actual change issues exactly one command.
  const persistedSplitsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const seen = persistedSplitsRef.current;
    const nextSeen: Record<string, string> = {};
    for (const [worktreeId, root] of Object.entries(state.splitRootByWorktree)) {
      if (root.kind !== "split") {
        continue;
      }
      const serialized = JSON.stringify(root);
      nextSeen[worktreeId] = serialized;
      if (seen[worktreeId] !== serialized) {
        void setSplitLayoutCommand(worktreeId, serialized).catch(() => undefined);
      }
    }
    for (const worktreeId of Object.keys(seen)) {
      if (!(worktreeId in nextSeen)) {
        void clearSplitLayoutCommand(worktreeId).catch(() => undefined);
      }
    }
    persistedSplitsRef.current = nextSeen;
  }, [state.splitRootByWorktree]);

  // Persist the active selection (last active project + per-project last active
  // worktree) so switching away from a project and coming back — even across
  // app restarts — returns to the worktree the user left off on. Inert until
  // the mount-time `reload` has rehydrated, so the initial empty state can't
  // clobber a saved selection; `lastPersistedRef` skips a no-op rewrite of the
  // value that was just loaded (and self-heals when `set-projects` had to fall
  // back because the persisted project was deleted elsewhere).
  useEffect(() => {
    if (!didHydrateRef.current) {
      return;
    }
    const json = serializeSelection(state.selectedProjectId, state.selectedWorktreeByProject);
    if (json === lastPersistedRef.current) {
      return;
    }
    lastPersistedRef.current = json;
    void setActiveSelection(json).catch((cause) => {
      toast.error(`Failed to save active selection: ${messageFor(cause)}`);
    });
  }, [state.selectedProjectId, state.selectedWorktreeByProject]);

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
        await openWorktreeCommand(selectedWorktree.id, editorId);
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
        await openWorktreeCommand(target.id, editorId);
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
  const legacyActiveTabId = (() => {
    if (!selectedWorktreeId) {
      return null;
    }
    const remembered = state.activeTabByWorktree[selectedWorktreeId];
    if (remembered && visibleTabs.some((tab) => tab.id === remembered)) {
      return remembered;
    }
    return visibleTabs[0]?.id ?? null;
  })();
  const storedSplitRoot = useMemo(
    () =>
      selectedWorktreeId
        ? normalizeRoot(
            state.splitRootByWorktree[selectedWorktreeId],
            selectedWorktreeId,
            state.tabs,
            legacyActiveTabId,
          )
        : null,
    [state.splitRootByWorktree, state.tabs, selectedWorktreeId, legacyActiveTabId],
  );
  const activeTabInStoredSplit = legacyActiveTabId
    ? paneContainingTab(storedSplitRoot, legacyActiveTabId)
    : null;
  const storedFocusedPane = focusForRoot(
    storedSplitRoot,
    selectedWorktreeId ? state.focusedPaneByWorktree[selectedWorktreeId] : null,
  );
  const splitRepresentativeTabId =
    storedSplitRoot?.kind === "split" ? (storedFocusedPane?.activeTabId ?? null) : null;
  const splitRoot = useMemo(() => {
    if (!selectedWorktreeId) {
      return null;
    }
    if (storedSplitRoot?.kind === "split") {
      if (legacyActiveTabId && !activeTabInStoredSplit) {
        return createPane(
          [legacyActiveTabId],
          legacyActiveTabId,
          `pane-regular-${legacyActiveTabId}`,
        );
      }
      return storedSplitRoot;
    }
    return (
      storedSplitRoot ?? initialRootForWorktree(selectedWorktreeId, state.tabs, legacyActiveTabId)
    );
  }, [activeTabInStoredSplit, legacyActiveTabId, selectedWorktreeId, state.tabs, storedSplitRoot]);
  const focusedPane = focusForRoot(
    splitRoot,
    selectedWorktreeId ? state.focusedPaneByWorktree[selectedWorktreeId] : null,
  );
  const focusedPaneId = splitRoot?.kind === "split" ? (focusedPane?.id ?? null) : null;
  const activeTabId = legacyActiveTabId;
  const activeTab = visibleTabs.find((tab) => tab.id === activeTabId) ?? null;

  const focusPane = useCallback(
    (paneId: string) => {
      if (!selectedWorktreeId) {
        return;
      }
      dispatch({ type: "focus-pane", worktreeId: selectedWorktreeId, paneId });
    },
    [selectedWorktreeId],
  );

  const setPaneActiveTab = useCallback(
    (paneId: string, tabId: string) => {
      if (!selectedWorktreeId) {
        return;
      }
      dispatch({ type: "set-pane-active-tab", worktreeId: selectedWorktreeId, paneId, tabId });
    },
    [selectedWorktreeId],
  );

  const splitTabAtPane = useCallback(
    (tabId: string, paneId: string, direction: SplitDirection, placement: SplitPlacement) => {
      if (!selectedWorktreeId) {
        return;
      }
      dispatch({
        type: "split-pane",
        worktreeId: selectedWorktreeId,
        paneId,
        tabId,
        direction,
        placement,
      });
    },
    [selectedWorktreeId],
  );

  const splitActivePane = useCallback(
    (tabId: string, direction: SplitDirection) => {
      if (!selectedWorktreeId) {
        return;
      }
      dispatch({
        type: "split-pane",
        worktreeId: selectedWorktreeId,
        paneId: focusedPaneId,
        tabId,
        direction,
        placement: "after",
      });
    },
    [focusedPaneId, selectedWorktreeId],
  );

  const moveTabToPane = useCallback(
    (tabId: string, paneId: string) => {
      if (!selectedWorktreeId) {
        return;
      }
      dispatch({ type: "move-tab-to-pane", worktreeId: selectedWorktreeId, paneId, tabId });
    },
    [selectedWorktreeId],
  );

  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      if (visibleTabs.length === 0 || !activeTabId || !selectedWorktreeId) {
        return;
      }
      const storedSplitTabIds = tabIdsInNode(
        storedSplitRoot?.kind === "split" ? storedSplitRoot : null,
      );
      const activeStoredPane = paneContainingTab(storedSplitRoot, activeTabId);
      const paneTabIds = activeStoredPane
        ? activeStoredPane.tabIds
        : visibleTabs
            .map((tab) => tab.id)
            .filter(
              (tabId) =>
                !storedSplitTabIds.has(tabId) ||
                tabId === activeTabId ||
                tabId === splitRepresentativeTabId,
            );
      const current = paneTabIds.findIndex((tabId) => tabId === activeTabId);
      const next = (current + direction + paneTabIds.length) % paneTabIds.length;
      const tabId = paneTabIds[next];
      if (!tabId) {
        return;
      }
      if (activeStoredPane) {
        dispatch({
          type: "set-pane-active-tab",
          worktreeId: selectedWorktreeId,
          paneId: activeStoredPane.id,
          tabId,
        });
      } else {
        dispatch({ type: "set-active-tab", worktreeId: selectedWorktreeId, tabId });
      }
    },
    [visibleTabs, activeTabId, selectedWorktreeId, storedSplitRoot, splitRepresentativeTabId],
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
      splitRoot,
      focusedPaneId,
      reload,
      refreshProject,
      selectProject,
      selectWorktree,
      createTerminalTab,
      createBrowserTab,
      createTabInPane,
      openFileTab,
      openDiffTab,
      openDaemonLogTab,
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
      focusPane,
      setPaneActiveTab,
      splitActivePane,
      splitTabAtPane,
      moveTabToPane,
    }),
    [
      state,
      visibleTabs,
      selectedWorktreeId,
      activeTabId,
      activeProject,
      selectedWorktree,
      activeTab,
      splitRoot,
      focusedPaneId,
      reload,
      refreshProject,
      selectProject,
      selectWorktree,
      createTerminalTab,
      createBrowserTab,
      createTabInPane,
      openFileTab,
      openDiffTab,
      openDaemonLogTab,
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
      focusPane,
      setPaneActiveTab,
      splitActivePane,
      splitTabAtPane,
      moveTabToPane,
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
