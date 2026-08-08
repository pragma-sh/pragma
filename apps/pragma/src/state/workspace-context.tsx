import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { useRequiredContext } from "@/lib/context";

import { constants } from "@pragma/constants";
import type {
  AgentReportPayload,
  DiffSide,
  Project,
  ProjectIcon,
  ProjectScriptsConfig,
  Tab,
  Worktree,
  WorktreeStatus,
} from "@pragma/constants";

import { toast } from "sonner";

import { errorMessage } from "@/lib/errors";
import { subscribeToWorktreeFiles } from "@/lib/file-watch";
import { BROWSER_START_URL } from "@/lib/browser-manager";
import { EMPTY_MODEL_SELECTION, resolveDeepLinkAgentSelection } from "@/lib/agent-model-selection";
import { refreshAgentModels } from "@/lib/agent-model-cache";
import {
  alertAgent,
  latchAlertedStatus,
  releaseAlertLatch,
  releaseAlertLatchForTab,
  shouldAlertForStatus,
  type AgentAlertOptions,
} from "@/lib/agent-alert";
import type { AgentAlertLocation } from "@/lib/agent-notification-text";
import { startAgentInTab, startBackgroundAgentSession } from "@/lib/agent-launch";
import {
  parseNewSessionDeepLink,
  parsePluginDeepLink,
  requestNewSession,
  requestPluginDeepLink,
} from "@/lib/deep-link";
import { basename } from "@/lib/path";
import {
  planInteractiveScripts,
  type RunScriptLayoutTemplate,
  type PlannedRunScripts,
} from "@/lib/scripts";
import { defaultTabTitle } from "@/lib/tab-title";
import { terminalManager } from "@/lib/terminal-manager";
import { setTerminalLinkHandler } from "@/lib/terminal-links";
import {
  browserClose,
  browserOpenExternal,
  pathExists,
  clearSplitLayout as clearSplitLayoutCommand,
  closeTab as closeTabCommand,
  createPluginWebViewTab,
  createTab as createTabCommand,
  deleteWorktree as deleteWorktreeCommand,
  getActiveSelection,
  listProjects,
  loadProjectScripts,
  listSplits,
  listTabs,
  listWorktrees,
  touchWorktreeMru,
  markAgentsSeen,
  onBrowserFocusRequest,
  onBrowserMeta,
  onAgentCliPathWarning,
  onAgentMessage,
  onAgentNotificationClick,
  onAgentReport,
  onAgentSessionLaunch,
  onAgentStatusReset,
  onDeepLink,
  onTabsChanged,
  onWorktreeChanged,
  takePendingDeepLink,
  openScratchpadTab as openScratchpadTabCommand,
  openWorktree as openWorktreeCommand,
  projectIcon,
  renameTab as renameTabCommand,
  renameWorktree as renameWorktreeCommand,
  setActiveSelection,
  setSplitLayout as setSplitLayoutCommand,
  setTabAgent as setTabAgentCommand,
  setTabTitle as setTabTitleCommand,
  setTabUrl as setTabUrlCommand,
  setWorktreeHidden as setWorktreeHiddenCommand,
  worktreeStatus as worktreeStatusCommand,
  worktreesAreRemote,
  type WorkspaceChangedEvent,
} from "@/lib/tauri";
import type { AgentConfig, AgentModelSelection, SplitLayout } from "@/lib/tauri";
import { listPluginAgents, resolvePluginAgentModels } from "@/plugins/agents";
import { requestEditorLocation } from "@/state/editor-location-store";
import type { OpenPluginWebViewRequest } from "@/plugins/webviews";
import {
  agentStatusesForTab,
  applyAgentMessage,
  applyAgentReport,
  clearAllAgentStatuses,
  clearDoneStatusForTab,
  removeAgentStatusForTab,
} from "@/state/agent-status-store";

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
  /** True for worktrees whose project is routed through an SSH host. */
  remoteWorktrees: Record<string, boolean>;
  icons: Record<string, ProjectIcon | null>;
  loading: boolean;
  error: string | null;
}

/** Prior split layout saved before interactive scripts temporarily replace it. */
export type RunScriptsSplitSnapshot = { root: SplitLayoutNode | null };

/** One active interactive project script shown in cross-worktree navigation. */
interface RunningScript {
  worktreeId: string;
  tabId: string;
  name: string;
  stopping: boolean;
}

/** One script's header button: `run`/`build` are always present; other keys are custom scripts. */
export interface ScriptButtonInfo {
  name: string;
  /** Iconify icon name from `.pragma/scripts.json`; null falls back to a built-in icon. */
  icon: string | null;
  available: boolean;
}

/** One running instance of a named script within a worktree. */
export type ManagedScriptEntry = {
  worktreeId: string;
  name: string;
  tabIds: string[];
  stopping: boolean;
  /** Non-null when scripts applied a split layout that overwrote the worktree root. */
  splitSnapshot: RunScriptsSplitSnapshot | null;
};

/**
 * Active interactive scripts, isolated by worktree and keyed by script name so
 * multiple different scripts (e.g. `run` and `lint`) can run concurrently in
 * the same worktree; the same named script can only run once at a time.
 */
export type ManagedScriptsState = Record<string, Record<string, ManagedScriptEntry>>;

/** The interactive scripts currently running for a worktree, if any. */
function activeManagedScripts(
  state: ManagedScriptsState,
  worktreeId: string | null,
): Array<{ name: string; stopping: boolean }> {
  const scripts = worktreeId ? state[worktreeId] : undefined;
  if (!scripts) {
    return [];
  }
  return Object.values(scripts).map(({ name, stopping }) => ({ name, stopping }));
}

export type WorkspaceAction =
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
  | { type: "set-splits"; projectId: string; worktreeRoots: Record<string, SplitLayoutNode> }
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
  | { type: "set-split-root"; worktreeId: string; root: SplitLayoutNode }
  | { type: "clear-split-root"; worktreeId: string }
  | { type: "add-tab"; tab: Tab; focus?: boolean }
  | { type: "add-tab-to-pane"; tab: Tab; paneId: string }
  | {
      type: "open-in-new-split";
      tab: Tab;
      sourceTabId: string;
      direction: SplitDirection;
      placement: SplitPlacement;
    }
  | { type: "remove-tab"; tabId: string }
  | { type: "rename-tab"; tabId: string; title: string }
  | { type: "set-auto-title"; tabId: string; title: string }
  | { type: "set-session-title"; tabId: string; title: string }
  | { type: "set-tab-agent"; tabId: string; agentId: string; title: string }
  | { type: "set-tab-url"; tabId: string; url: string }
  | { type: "set-icon"; projectId: string; icon: ProjectIcon | null }
  | { type: "set-worktree-remote"; worktreeId: string; isRemote: boolean }
  | { type: "remove-worktree"; worktreeId: string }
  | { type: "update-worktree"; worktree: Worktree }
  | { type: "clear-error" };

interface WorkspaceContextValue extends WorkspaceState {
  /** Tabs belonging to the selected worktree (the visible set). */
  tabs: Tab[];
  /** Every tab loaded for the selected project, across worktrees. */
  projectTabs: Tab[];
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
  selectWorktree: (worktreeId: string | null, projectId?: string) => void;
  createTerminalTab: (worktreeId?: string, options?: WorktreeTargetOptions) => Promise<Tab | null>;
  createBrowserTab: (worktreeId?: string) => Promise<Tab | null>;
  /**
   * Launches an agent thread in a worktree: switches to it, opens a terminal
   * tab, starts the agent, and optionally prefills its TUI with `message`.
   */
  startSession: (
    worktreeId: string,
    agent: AgentConfig,
    message?: string,
    modelSelection?: AgentModelSelection,
    options?: WorktreeTargetOptions,
  ) => Promise<Tab | null>;
  /** Create a new tab inside a specific split pane (the pane's "+" button). */
  createTabInPane: (paneId: string, kind: "terminal" | "browser") => Promise<void>;
  /** Opens (or focuses) an editor tab for a worktree-relative file path. */
  openFileTab: (path: string, opts?: { paneId?: string }) => Promise<void>;
  /** Opens (or focuses) a read-only diff tab for a worktree-relative file path. */
  openDiffTab: (
    path: string,
    side: DiffSide,
    opts?: { paneId?: string; commit?: string | null },
  ) => Promise<void>;
  /** Opens (or focuses) the PR review tab for a pull request number. */
  openReviewTab: (prNumber: number, title: string) => Promise<void>;
  /** Opens (or focuses) the read-only daemon-log tab (Troubleshooting menu). */
  openDaemonLogTab: () => Promise<void>;
  /** Opens (or focuses) a plugin-defined web view tab. */
  openPluginWebView: (request: OpenPluginWebViewRequest) => Promise<void>;
  /** Opens (or focuses) a managed scratchpad tab for a worktree-relative MDX file. */
  openScratchpadFile: (filePath: string, title: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  renameTerminalTab: (tabId: string, title: string) => Promise<void>;
  markTabAgent: (tabId: string, agent: AgentConfig) => Promise<void>;
  openSelectedWorktree: (editorId?: string | null) => Promise<void>;
  openWorktreeInEditor: (worktreeId: string, editorId?: string | null) => Promise<void>;
  cycleTab: (direction: 1 | -1) => void;
  setActiveTab: (tabId: string | null) => void;
  activateTabLocation: (projectId: string, worktreeId: string, tabId: string) => Promise<void>;
  openFileLocation: (input: {
    projectId: string;
    worktreeId: string;
    path: string;
    line?: number;
    column?: number;
  }) => Promise<void>;
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
  /** Header script buttons in display order: `run`, `build`, then any custom scripts alphabetically. */
  scriptButtons: ScriptButtonInfo[];
  /** Set when `.pragma/scripts.json` fails to load or parse; null when valid or not yet loaded. */
  runScriptsConfigError: string | null;
  /** The interactive scripts currently running for the selected worktree. */
  activeScripts: Array<{ name: string; stopping: boolean }>;
  runningScripts: RunningScript[];
  runScript: (name: string) => Promise<void>;
  stopScript: (name: string) => Promise<void>;
  agentBackAvailable?: boolean;
  navigateToAgentLocation?: (projectId: string, worktreeId: string, tabId: string) => Promise<void>;
  goBackFromAgent?: () => Promise<void>;
}

/** Explicit owner for operations whose worktree is not in the loaded project snapshot. */
interface WorktreeTargetOptions {
  projectId?: string;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const TERMINAL_TITLE_FLUSH_MS = 100;
/** Wait after script tabs mount before injecting commands so the PTY shell is ready. */
const INTERACTIVE_SCRIPT_START_DELAY_MS = 2000;
const TERMINAL_TAB_ID_SEPARATOR = "\u0000";
const AGENT_BACK_TTL_MS = 10 * 60 * 1000;

interface AgentBackLocation {
  projectId: string;
  worktreeId: string;
  tabId: string;
  expiresAt: number;
}

const initialState: WorkspaceState = {
  projects: [],
  worktrees: {},
  tabs: [],
  selectedProjectId: null,
  selectedWorktreeByProject: {},
  activeTabByWorktree: {},
  splitRootByWorktree: {},
  focusedPaneByWorktree: {},
  remoteWorktrees: {},
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

function restoreRunScriptsSplitSnapshot(
  dispatch: React.Dispatch<WorkspaceAction>,
  worktreeId: string,
  snapshot: RunScriptsSplitSnapshot,
) {
  if (snapshot.root) {
    dispatch({ type: "set-split-root", worktreeId, root: snapshot.root });
  } else {
    dispatch({ type: "clear-split-root", worktreeId });
  }
}

/**
 * Pops `scriptName` off its worktree's layout stack and reconciles its snapshot.
 * Concurrent scripts with split layouts each overwrite the whole worktree root, so
 * their "restore to this on stop" snapshots form a stack in push order. If a newer
 * script's layout is still on top, that script's layout must stay visible — instead
 * this splices `scriptName` out by handing its snapshot to the next-newer script, so
 * that script's own eventual stop restores past `scriptName` instead of pointing at
 * `scriptName`'s now-stale pane/tab ids. Only when `scriptName` is topmost (nothing
 * newer above it) does the snapshot actually get applied to the visible layout.
 */
export function popScriptLayout(
  dispatch: React.Dispatch<WorkspaceAction>,
  setManagedScriptsState: Dispatch<SetStateAction<ManagedScriptsState>>,
  layoutStackRef: RefObject<Record<string, string[]>>,
  worktreeId: string,
  scriptName: string,
  snapshot: RunScriptsSplitSnapshot,
): void {
  const stack = layoutStackRef.current[worktreeId] ?? [];
  const index = stack.indexOf(scriptName);
  const above = index === -1 ? undefined : stack[index + 1];
  const nextStack = stack.filter((entry) => entry !== scriptName);
  if (nextStack.length > 0) {
    layoutStackRef.current = { ...layoutStackRef.current, [worktreeId]: nextStack };
  } else {
    const { [worktreeId]: _removed, ...rest } = layoutStackRef.current;
    layoutStackRef.current = rest;
  }
  if (above) {
    setManagedScriptsState((current) => {
      const aboveEntry = current[worktreeId]?.[above];
      if (!aboveEntry) {
        return current;
      }
      return {
        ...current,
        [worktreeId]: {
          ...current[worktreeId],
          [above]: { ...aboveEntry, splitSnapshot: snapshot },
        },
      };
    });
    return;
  }
  restoreRunScriptsSplitSnapshot(dispatch, worktreeId, snapshot);
}

function materializeRunScriptLayout(
  template: RunScriptLayoutTemplate,
  tabIdsByCommand: string[],
): SplitLayoutNode {
  if (template.kind === "pane") {
    const tabId = tabIdsByCommand[template.commandIndex];
    if (!tabId) {
      throw new Error(`missing terminal tab for run command ${template.commandIndex}`);
    }
    return createPane([tabId], tabId);
  }
  return {
    kind: "split",
    id: splitNodeId("split"),
    direction: template.direction,
    children: [
      materializeRunScriptLayout(template.children[0], tabIdsByCommand),
      materializeRunScriptLayout(template.children[1], tabIdsByCommand),
    ],
  };
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    const frame =
      window.requestAnimationFrame ??
      ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
    frame(() => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

/** Collects the active (on-screen) tab of every pane in a split layout. */
function activeTabIdsInNode(node: SplitLayoutNode | null | undefined): string[] {
  const activeTabIds: string[] = [];
  findPane(node, (pane) => {
    if (pane.activeTabId) {
      activeTabIds.push(pane.activeTabId);
    }
    return false;
  });
  return activeTabIds;
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

// Per-action reducer handlers. Each takes the state and its narrowed action and
// returns the next state, so `workspaceReducer` stays a thin dispatcher instead
// of one giant switch. Grouped roughly: loading/selection, then split-layout.
type ActionOf<T extends WorkspaceAction["type"]> = Extract<WorkspaceAction, { type: T }>;

function reduceSetProjects(
  state: WorkspaceState,
  action: ActionOf<"set-projects">,
): WorkspaceState {
  // Keep the already-selected (hydrated or user-chosen) project when it is still
  // in the loaded list; otherwise fall back to the first project. The guard is
  // what makes a persisted selection survive a restart while still recovering if
  // that project was deleted in another session.
  const persisted = state.selectedProjectId;
  const selectedProjectId =
    persisted && action.projects.some((project) => project.id === persisted)
      ? persisted
      : (action.projects[0]?.id ?? null);
  return { ...state, projects: action.projects, selectedProjectId, loading: false };
}

function reduceSetWorktrees(
  state: WorkspaceState,
  action: ActionOf<"set-worktrees">,
): WorkspaceState {
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

function reduceSetSplits(state: WorkspaceState, action: ActionOf<"set-splits">): WorkspaceState {
  // Merge persisted layouts for the loaded project's worktrees over whatever is
  // in memory, reconciling each against the current tabs (a tab may have been
  // closed in another window/session). Missing rows clear that project's stale
  // in-memory roots; other projects are untouched.
  const splitRootByWorktree = { ...state.splitRootByWorktree };
  const refreshedWorktreeIds = new Set(
    (state.worktrees[action.projectId] ?? []).map((worktree) => worktree.id),
  );
  for (const worktreeId of refreshedWorktreeIds) {
    if (!(worktreeId in action.worktreeRoots)) {
      delete splitRootByWorktree[worktreeId];
    }
  }
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

function reduceSetActiveTab(
  state: WorkspaceState,
  action: ActionOf<"set-active-tab">,
): WorkspaceState {
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

function reduceFocusPane(state: WorkspaceState, action: ActionOf<"focus-pane">): WorkspaceState {
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

function reduceSetPaneActiveTab(
  state: WorkspaceState,
  action: ActionOf<"set-pane-active-tab">,
): WorkspaceState {
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

function reduceSplitPane(state: WorkspaceState, action: ActionOf<"split-pane">): WorkspaceState {
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
  const sourcePane = resolveSplitSourcePane(
    root,
    action,
    state.focusedPaneByWorktree[action.worktreeId],
  );
  if (!sourcePane) {
    return state;
  }
  // When the worktree is not yet split the root is one implicit pane holding
  // every tab, but only the displayed (active) tab is really "shown" — so the new
  // split is [activeTab | droppedTab] and the other tabs fall back to being
  // normal top-bar tabs. Inside a real split the source pane keeps its own tabs.
  const implicit = root.kind === "pane";
  const keepIds = computeSplitKeepIds(sourcePane, action.tabId, implicit);
  if (keepIds.length === 0) {
    return state;
  }
  const targetPane = createPane([action.tabId], action.tabId);
  const currentPane = createPane(
    keepIds,
    pickCurrentPaneActiveTab(sourcePane, keepIds),
    sourcePane.id,
  );
  const splitNode = buildSplitNode(action.direction, action.placement, currentPane, targetPane);
  const nextRoot = applySplitToRoot(root, action, sourcePane, splitNode, implicit);
  return applySplitResult(state, action, nextRoot, targetPane.id);
}

/** Resolves the pane a tab is being split out of, honoring an explicit pane id then focus. */
function resolveSplitSourcePane(
  root: SplitLayoutNode,
  action: ActionOf<"split-pane">,
  focusedPaneId: string | undefined,
): SplitPaneNode | null {
  return (
    (action.paneId ? paneById(root, action.paneId) : null) ?? focusForRoot(root, focusedPaneId)
  );
}

/** Tabs that stay in the source pane after the split tab is pulled out. */
function computeSplitKeepIds(
  sourcePane: SplitPaneNode,
  tabId: string,
  implicit: boolean,
): string[] {
  const base = implicit
    ? sourcePane.activeTabId
      ? [sourcePane.activeTabId]
      : []
    : sourcePane.tabIds;
  return base.filter((id) => id !== tabId);
}

/** Picks the active tab for the staying pane: the source's active tab if still present. */
function pickCurrentPaneActiveTab(
  sourcePane: SplitPaneNode,
  keepIds: string[],
): string | undefined {
  return keepIds.includes(sourcePane.activeTabId ?? "")
    ? (sourcePane.activeTabId ?? undefined)
    : keepIds.at(-1);
}

/** Builds the new split node, ordering panes by the requested placement. */
function buildSplitNode(
  direction: SplitDirection,
  placement: SplitPlacement,
  currentPane: SplitPaneNode,
  targetPane: SplitPaneNode,
): SplitLayoutNode {
  return {
    kind: "split",
    id: splitNodeId("split"),
    direction,
    children: placement === "after" ? [currentPane, targetPane] : [targetPane, currentPane],
  };
}

/** Inserts the new split into the root, replacing the implicit pane or the source pane. */
function applySplitToRoot(
  root: SplitLayoutNode,
  action: ActionOf<"split-pane">,
  sourcePane: SplitPaneNode,
  splitNode: SplitLayoutNode,
  implicit: boolean,
): SplitLayoutNode {
  return implicit
    ? splitNode
    : replacePane(removeTabFromNode(root, action.tabId) ?? root, sourcePane.id, () => splitNode);
}

/** Writes the new root, active tab, and focused pane back into state. */
function applySplitResult(
  state: WorkspaceState,
  action: ActionOf<"split-pane">,
  nextRoot: SplitLayoutNode,
  targetPaneId: string,
): WorkspaceState {
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
      [action.worktreeId]: targetPaneId,
    },
  };
}

function reduceMoveTabToPane(
  state: WorkspaceState,
  action: ActionOf<"move-tab-to-pane">,
): WorkspaceState {
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

function reduceSetSplitRoot(
  state: WorkspaceState,
  action: ActionOf<"set-split-root">,
): WorkspaceState {
  const first = firstPane(action.root);
  return {
    ...state,
    activeTabByWorktree: first?.activeTabId
      ? { ...state.activeTabByWorktree, [action.worktreeId]: first.activeTabId }
      : state.activeTabByWorktree,
    splitRootByWorktree: {
      ...state.splitRootByWorktree,
      [action.worktreeId]: action.root,
    },
    focusedPaneByWorktree: first
      ? { ...state.focusedPaneByWorktree, [action.worktreeId]: first.id }
      : state.focusedPaneByWorktree,
  };
}

function reduceClearSplitRoot(
  state: WorkspaceState,
  action: ActionOf<"clear-split-root">,
): WorkspaceState {
  const splitRootByWorktree = { ...state.splitRootByWorktree };
  delete splitRootByWorktree[action.worktreeId];
  const focusedPaneByWorktree = { ...state.focusedPaneByWorktree };
  delete focusedPaneByWorktree[action.worktreeId];
  return { ...state, splitRootByWorktree, focusedPaneByWorktree };
}

function reduceAddTabToPane(
  state: WorkspaceState,
  action: ActionOf<"add-tab-to-pane">,
): WorkspaceState {
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

function reduceOpenInNewSplit(
  state: WorkspaceState,
  action: ActionOf<"open-in-new-split">,
): WorkspaceState {
  // Add a freshly-created tab and split it into a new pane next to the source
  // tab (the terminal the link was clicked in). Mirrors `split-pane`, but the new
  // tab is the one pulled into the new pane and the source tab stays put — used
  // by terminal-link "open to the right" actions.
  const { tab, sourceTabId, direction, placement } = action;
  const worktreeId = tab.worktreeId;
  const tabs = [...state.tabs, tab];
  const activeTabByWorktree = { ...state.activeTabByWorktree, [worktreeId]: tab.id };
  const sourceTab = state.tabs.find((item) => item.id === sourceTabId);
  // Stale or cross-worktree source ids must not enter keepIds — fall back to a
  // normal top-bar tab (same as add-tab) instead of corrupting split state.
  if (!sourceTab || sourceTab.worktreeId !== worktreeId) {
    return { ...state, tabs, activeTabByWorktree };
  }
  // Normalize anchored on the source tab so the implicit single-pane root keeps
  // the source (not the just-added tab) as its active tab.
  const root = normalizeRoot(state.splitRootByWorktree[worktreeId], worktreeId, tabs, sourceTabId);
  const sourcePane = paneContainingTab(root, sourceTabId) ?? firstPane(root);
  if (!root || !sourcePane) {
    return { ...state, tabs, activeTabByWorktree };
  }
  // When un-split the root is one implicit pane holding every tab, but only the
  // source tab should follow into the split; the rest fall back to normal top-bar
  // tabs (matching drag-to-split). Inside a real split the source pane keeps its
  // own tabs.
  const implicit = root.kind === "pane";
  const keepIds = computeOpenSplitKeepIds(sourcePane, sourceTabId, implicit, tab.id);
  if (keepIds.length === 0) {
    return { ...state, tabs, activeTabByWorktree };
  }
  const targetPane = createPane([tab.id], tab.id);
  const stayingPane = createPane(keepIds, sourceTabId, sourcePane.id);
  const splitNode = buildOpenSplitNode(direction, placement, stayingPane, targetPane);
  const nextRoot = applyOpenSplitToRoot(root, tab.id, sourcePane.id, splitNode, implicit);
  return {
    ...state,
    tabs,
    activeTabByWorktree,
    splitRootByWorktree: { ...state.splitRootByWorktree, [worktreeId]: nextRoot },
    focusedPaneByWorktree: { ...state.focusedPaneByWorktree, [worktreeId]: targetPane.id },
  };
}

/** Tabs that stay in the source pane when opening a new tab into a split. */
function computeOpenSplitKeepIds(
  sourcePane: SplitPaneNode,
  sourceTabId: string,
  implicit: boolean,
  newTabId: string,
): string[] {
  const base = implicit ? [sourceTabId] : sourcePane.tabIds;
  return base.filter((id) => id !== newTabId);
}

/** Builds the split node for an open-in-new-split, ordering panes by placement. */
function buildOpenSplitNode(
  direction: SplitDirection,
  placement: SplitPlacement,
  stayingPane: SplitPaneNode,
  targetPane: SplitPaneNode,
): SplitLayoutNode {
  return {
    kind: "split",
    id: splitNodeId("split"),
    direction,
    children: placement === "after" ? [stayingPane, targetPane] : [targetPane, stayingPane],
  };
}

/** Inserts the open-in-new-split node into the root, mirroring `applySplitToRoot`. */
function applyOpenSplitToRoot(
  root: SplitLayoutNode,
  newTabId: string,
  sourcePaneId: string,
  splitNode: SplitLayoutNode,
  implicit: boolean,
): SplitLayoutNode {
  return implicit
    ? splitNode
    : replacePane(removeTabFromNode(root, newTabId) ?? root, sourcePaneId, () => splitNode);
}

type RemovedLayout = {
  splitRootByWorktree: WorkspaceState["splitRootByWorktree"];
  focusedPaneByWorktree: WorkspaceState["focusedPaneByWorktree"];
  sourcePane: SplitPaneNode | null;
  nextRoot: SplitLayoutNode | null;
};

/**
 * Removes `tabId` from its worktree's split layout, returning the updated
 * root/focus maps plus the pane it lived in and the resulting root (both null
 * when the worktree has no split). Pure: the input maps are never mutated.
 */
function removeTabFromLayout(
  state: WorkspaceState,
  worktreeId: string,
  tabId: string,
): RemovedLayout {
  const root = state.splitRootByWorktree[worktreeId];
  if (!root) {
    return {
      splitRootByWorktree: state.splitRootByWorktree,
      focusedPaneByWorktree: state.focusedPaneByWorktree,
      sourcePane: null,
      nextRoot: null,
    };
  }
  const sourcePane = paneContainingTab(root, tabId);
  const nextRoot = removeTabFromNode(root, tabId);
  const splitRootByWorktree = { ...state.splitRootByWorktree };
  const focusedPaneByWorktree = { ...state.focusedPaneByWorktree };
  if (nextRoot) {
    const focusedPane = focusForRoot(nextRoot, focusedPaneByWorktree[worktreeId]);
    splitRootByWorktree[worktreeId] = nextRoot;
    if (focusedPane) {
      focusedPaneByWorktree[worktreeId] = focusedPane.id;
    }
  } else {
    delete splitRootByWorktree[worktreeId];
    delete focusedPaneByWorktree[worktreeId];
  }
  return { splitRootByWorktree, focusedPaneByWorktree, sourcePane, nextRoot };
}

/**
 * Picks a worktree's next active tab after its current active tab is closed: the
 * restored pane's active tab, else the last remaining tab not already shown in a
 * pane, else any remaining tab in the worktree (`undefined` when none remain).
 */
function nextActiveTabAfterRemoval(
  worktreeId: string,
  remainingTabs: Tab[],
  layout: RemovedLayout,
): string | undefined {
  const nextPane =
    layout.sourcePane && layout.nextRoot ? paneById(layout.nextRoot, layout.sourcePane.id) : null;
  const restoredTabIds = layout.nextRoot ? tabIdsInNode(layout.nextRoot) : new Set<string>();
  return (
    nextPane?.activeTabId ??
    remainingTabs.findLast((tab) => tab.worktreeId === worktreeId && !restoredTabIds.has(tab.id))
      ?.id ??
    remainingTabs.findLast((tab) => tab.worktreeId === worktreeId)?.id
  );
}

function reduceRemoveTab(state: WorkspaceState, action: ActionOf<"remove-tab">): WorkspaceState {
  const removed = state.tabs.find((tab) => tab.id === action.tabId);
  const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
  if (!removed) {
    return { ...state, tabs };
  }
  const layout = removeTabFromLayout(state, removed.worktreeId, action.tabId);
  let activeTabByWorktree = state.activeTabByWorktree;
  if (state.activeTabByWorktree[removed.worktreeId] === action.tabId) {
    const fallback = nextActiveTabAfterRemoval(removed.worktreeId, tabs, layout);
    activeTabByWorktree = { ...activeTabByWorktree };
    if (fallback) {
      activeTabByWorktree[removed.worktreeId] = fallback;
    } else {
      delete activeTabByWorktree[removed.worktreeId];
    }
  }
  return {
    ...state,
    tabs,
    activeTabByWorktree,
    splitRootByWorktree: layout.splitRootByWorktree,
    focusedPaneByWorktree: layout.focusedPaneByWorktree,
  };
}

function reduceRemoveWorktree(
  state: WorkspaceState,
  action: ActionOf<"remove-worktree">,
): WorkspaceState {
  // Filter the row out of every project list and drop tabs owned by it (SQLite
  // cascades, but our local snapshot still has them). The Tauri side has already
  // terminated the worktree's PTY sessions by the time we get here, so we just
  // need to keep the in-memory state in sync.
  const worktrees: Record<string, Worktree[]> = {};
  const selectedWorktreeByProject: Record<string, string> = {
    ...state.selectedWorktreeByProject,
  };
  for (const [projectId, projectWorktrees] of Object.entries(state.worktrees)) {
    worktrees[projectId] = pruneRemovedWorktreeFromProject(
      projectWorktrees,
      action.worktreeId,
      selectedWorktreeByProject,
      projectId,
    );
  }
  const tabs = state.tabs.filter((tab) => tab.worktreeId !== action.worktreeId);
  // Drop the worktree's split layout/focus too (SQLite cascades the `splits` row
  // via the worktree FK; this keeps the in-memory snapshot in sync).
  const { splitRootByWorktree, focusedPaneByWorktree } = dropWorktreeLayoutMaps(
    state,
    action.worktreeId,
  );
  const remoteWorktrees = { ...state.remoteWorktrees };
  delete remoteWorktrees[action.worktreeId];
  return {
    ...state,
    worktrees,
    selectedWorktreeByProject,
    tabs,
    splitRootByWorktree,
    focusedPaneByWorktree,
    remoteWorktrees,
  };
}

/** Removes a worktree from one project's list, fixing up that project's selection. */
function pruneRemovedWorktreeFromProject(
  projectWorktrees: Worktree[],
  removedId: string,
  selectedWorktreeByProject: Record<string, string>,
  projectId: string,
): Worktree[] {
  const remaining = projectWorktrees.filter((worktree) => worktree.id !== removedId);
  if (remaining.length === projectWorktrees.length) {
    return projectWorktrees;
  }
  if (selectedWorktreeByProject[projectId] === removedId) {
    const fallback = pickFallbackWorktree(remaining);
    if (fallback) {
      selectedWorktreeByProject[projectId] = fallback;
    } else {
      delete selectedWorktreeByProject[projectId];
    }
  }
  return remaining;
}

/** Picks the worktree to select after the selected one is removed: main, then root, then first. */
function pickFallbackWorktree(remaining: Worktree[]): string | undefined {
  return (
    remaining.find((worktree) => worktree.isMain)?.id ??
    remaining.find((worktree) => worktree.parentId === null)?.id ??
    remaining[0]?.id
  );
}

/** Returns copies of the split/focus maps with one worktree's entries dropped. */
function dropWorktreeLayoutMaps(
  state: WorkspaceState,
  worktreeId: string,
): Pick<WorkspaceState, "splitRootByWorktree" | "focusedPaneByWorktree"> {
  const splitRootByWorktree = { ...state.splitRootByWorktree };
  delete splitRootByWorktree[worktreeId];
  const focusedPaneByWorktree = { ...state.focusedPaneByWorktree };
  delete focusedPaneByWorktree[worktreeId];
  return { splitRootByWorktree, focusedPaneByWorktree };
}

function reduceUpdateWorktree(
  state: WorkspaceState,
  action: ActionOf<"update-worktree">,
): WorkspaceState {
  // Patch a single worktree row in-place (rename, hide/show). The per-worktree
  // active-tab map is untouched because ids don't change.
  const worktrees: Record<string, Worktree[]> = {};
  for (const [projectId, projectWorktrees] of Object.entries(state.worktrees)) {
    worktrees[projectId] = projectWorktrees.map((worktree) =>
      worktree.id === action.worktree.id ? action.worktree : worktree,
    );
  }
  return { ...state, worktrees };
}

function reduceLoadStart(state: WorkspaceState, _action: ActionOf<"load-start">): WorkspaceState {
  return { ...state, loading: true, error: null };
}

function reduceLoadError(state: WorkspaceState, action: ActionOf<"load-error">): WorkspaceState {
  return { ...state, loading: false, error: action.error };
}

function reduceHydrateSelection(
  state: WorkspaceState,
  action: ActionOf<"hydrate-selection">,
): WorkspaceState {
  // Seeds the active project + per-project worktree map from the persisted
  // selection before `set-projects` runs, so the project-load effect lands on
  // the remembered project/worktree instead of the first/main one.
  return {
    ...state,
    selectedProjectId: action.projectId,
    selectedWorktreeByProject: { ...action.worktreeByProject },
  };
}

function reduceSetTabs(state: WorkspaceState, action: ActionOf<"set-tabs">): WorkspaceState {
  // A refresh can race a local `set-tab-agent`: list_tabs may still lack the
  // daemon overlay. Keep any in-memory agent identity the refresh omitted.
  const previousById = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const tabs = action.tabs.map((tab) => {
    if (tab.agentId) {
      return tab;
    }
    const previous = previousById.get(tab.id);
    if (!previous?.agentId) {
      return tab;
    }
    return {
      ...tab,
      agentId: previous.agentId,
      title: tab.userRenamed ? tab.title : (previous.title ?? tab.title),
    };
  });
  return {
    ...state,
    tabs,
    splitRootByWorktree: rootsForTabs(state.splitRootByWorktree, tabs),
  };
}

function reduceSelectProject(
  state: WorkspaceState,
  action: ActionOf<"select-project">,
): WorkspaceState {
  return { ...state, selectedProjectId: action.projectId };
}

function reduceSelectWorktree(
  state: WorkspaceState,
  action: ActionOf<"select-worktree">,
): WorkspaceState {
  return {
    ...state,
    selectedWorktreeByProject: {
      ...state.selectedWorktreeByProject,
      [action.projectId]: action.worktreeId,
    },
  };
}

function reduceAddTab(state: WorkspaceState, action: ActionOf<"add-tab">): WorkspaceState {
  if (action.focus === false) {
    return { ...state, tabs: [...state.tabs, action.tab] };
  }
  return {
    ...state,
    tabs: [...state.tabs, action.tab],
    activeTabByWorktree: {
      ...state.activeTabByWorktree,
      [action.tab.worktreeId]: action.tab.id,
    },
  };
}

function reduceRenameTab(state: WorkspaceState, action: ActionOf<"rename-tab">): WorkspaceState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === action.tabId ? { ...tab, title: action.title, userRenamed: true } : tab,
    ),
  };
}

function reduceSetAutoTitle(
  state: WorkspaceState,
  action: ActionOf<"set-auto-title">,
): WorkspaceState {
  // Shell/browser-emitted title. Respects `userRenamed` so a user-typed rename
  // can never be silently clobbered by a `precmd`/`PROMPT_COMMAND` title push
  // or a stray `<title>` update from a browser webview. A blank push (e.g.
  // opencode clearing the title on exit) falls back to the kind's default so
  // the tab never goes nameless.
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === action.tabId && !tab.userRenamed && !tab.agentId
        ? { ...tab, title: action.title.trim() || defaultTabTitle(tab.kind) }
        : tab,
    ),
  };
}

function reduceSetSessionTitle(
  state: WorkspaceState,
  action: ActionOf<"set-session-title">,
): WorkspaceState {
  // Agent-reported session name. Respects `userRenamed` so a manual rename is
  // never clobbered; unlike auto-titles it applies to agent tabs (which ignore
  // shell OSC titles entirely).
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === action.tabId && !tab.userRenamed ? { ...tab, title: action.title } : tab,
    ),
  };
}

function reduceSetTabAgent(
  state: WorkspaceState,
  action: ActionOf<"set-tab-agent">,
): WorkspaceState {
  // Marks the tab as agent-owned at launch: the agent's icon takes over and
  // the title seeds with the agent's display name (user renames win).
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === action.tabId
        ? { ...tab, agentId: action.agentId, title: tab.userRenamed ? tab.title : action.title }
        : tab,
    ),
  };
}

function reduceSetTabUrl(state: WorkspaceState, action: ActionOf<"set-tab-url">): WorkspaceState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === action.tabId ? { ...tab, url: action.url } : tab)),
  };
}

function reduceSetIcon(state: WorkspaceState, action: ActionOf<"set-icon">): WorkspaceState {
  return { ...state, icons: { ...state.icons, [action.projectId]: action.icon } };
}

function reduceSetWorktreeRemote(
  state: WorkspaceState,
  action: ActionOf<"set-worktree-remote">,
): WorkspaceState {
  return {
    ...state,
    remoteWorktrees: { ...state.remoteWorktrees, [action.worktreeId]: action.isRemote },
  };
}

function reduceClearError(state: WorkspaceState, _action: ActionOf<"clear-error">): WorkspaceState {
  return { ...state, error: null };
}

type ReducerMap = {
  [K in WorkspaceAction["type"]]: (state: WorkspaceState, action: ActionOf<K>) => WorkspaceState;
};

const REDUCERS: ReducerMap = {
  "load-start": reduceLoadStart,
  "load-error": reduceLoadError,
  "set-projects": reduceSetProjects,
  "hydrate-selection": reduceHydrateSelection,
  "set-worktrees": reduceSetWorktrees,
  "set-tabs": reduceSetTabs,
  "set-splits": reduceSetSplits,
  "select-project": reduceSelectProject,
  "select-worktree": reduceSelectWorktree,
  "set-active-tab": reduceSetActiveTab,
  "focus-pane": reduceFocusPane,
  "set-pane-active-tab": reduceSetPaneActiveTab,
  "split-pane": reduceSplitPane,
  "move-tab-to-pane": reduceMoveTabToPane,
  "set-split-root": reduceSetSplitRoot,
  "clear-split-root": reduceClearSplitRoot,
  "add-tab": reduceAddTab,
  "add-tab-to-pane": reduceAddTabToPane,
  "open-in-new-split": reduceOpenInNewSplit,
  "remove-tab": reduceRemoveTab,
  "rename-tab": reduceRenameTab,
  "set-auto-title": reduceSetAutoTitle,
  "set-session-title": reduceSetSessionTitle,
  "set-tab-agent": reduceSetTabAgent,
  "set-tab-url": reduceSetTabUrl,
  "set-icon": reduceSetIcon,
  "set-worktree-remote": reduceSetWorktreeRemote,
  "remove-worktree": reduceRemoveWorktree,
  "update-worktree": reduceUpdateWorktree,
  "clear-error": reduceClearError,
};

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  return REDUCERS[action.type](state, action as never);
}

type DeepLink = NonNullable<ReturnType<typeof parseNewSessionDeepLink>>;
type AgentModelOptions = Parameters<typeof resolveDeepLinkAgentSelection>[2];

/** Resolves and selects the deep link's target worktree, returning its id (or null if unknown). */
async function resolveDeepLinkWorktreeSelection(
  link: DeepLink,
  resolveProjectForWorktree: (worktreeId: string) => Promise<string | null>,
  selectProject: (projectId: string) => Promise<void>,
  selectWorktree: (worktreeId: string) => void,
): Promise<string | null> {
  if (!link.worktreeId) {
    return null;
  }
  const projectId = await resolveProjectForWorktree(link.worktreeId);
  if (!projectId) {
    // Unknown worktree id: ignore it and fall back to the current selection.
    return null;
  }
  await selectProject(projectId);
  // Route through `selectWorktree` (not a raw dispatch) so its side effects run —
  // notably clearing `agentBackLocation`, so a deep-link jump doesn't leave the
  // notification-only "Go back" affordance up.
  selectWorktree(link.worktreeId);
  return link.worktreeId;
}

/** Picks the worktree the deep link should target, falling back to the current selection. */
function resolveDeepLinkTargetWorktree(
  state: WorkspaceState,
  worktreeId: string | null,
): string | null {
  return (
    worktreeId ??
    (state.selectedProjectId
      ? (state.selectedWorktreeByProject[state.selectedProjectId] ?? null)
      : null)
  );
}

/** Auto-launches the agent when the deep link carries everything it needs. Returns true if handled. */
async function autoSubmitDeepLink(
  link: DeepLink,
  targetWorktreeId: string | null,
  listPluginAgentsFn: () => Promise<AgentConfig[]>,
  resolvePluginAgentModelsFn: (agentId: string) => Promise<AgentModelOptions[string]>,
  startSession: (
    worktreeId: string,
    agent: AgentConfig,
    message?: string,
    modelSelection?: AgentModelSelection,
  ) => Promise<unknown>,
): Promise<boolean> {
  if (!link.autoSubmit || !targetWorktreeId || !link.message?.trim()) {
    return false;
  }
  const agents = await listPluginAgentsFn().catch(() => [] as AgentConfig[]);
  const agent = resolveAutoSubmitAgent(link, agents);
  if (!agent) {
    return false;
  }
  await startAutoSubmitSession(
    link,
    targetWorktreeId,
    agent,
    agents,
    resolvePluginAgentModelsFn,
    startSession,
  );
  return true;
}

/** Picks the agent to auto-launch: the requested one (resolved against known agents), else the first. */
function resolveAutoSubmitAgent(link: DeepLink, agents: AgentConfig[]): AgentConfig | undefined {
  const requestedAgent = link.agentId
    ? (resolveDeepLinkAgentSelection(link, agents, {}).agentId ?? link.agentId)
    : null;
  return agents.find((item) => item.id === requestedAgent) ?? agents[0];
}

/** Resolves the agent's model selection and launches the auto-submitted session. */
async function startAutoSubmitSession(
  link: DeepLink,
  targetWorktreeId: string,
  agent: AgentConfig,
  agents: AgentConfig[],
  resolvePluginAgentModelsFn: (agentId: string) => Promise<AgentModelOptions[string]>,
  startSession: (
    worktreeId: string,
    agent: AgentConfig,
    message?: string,
    modelSelection?: AgentModelSelection,
  ) => Promise<unknown>,
): Promise<void> {
  const models = await resolvePluginAgentModelsFn(agent.id).catch(() => []);
  const resolved = resolveDeepLinkAgentSelection(link, agents, { [agent.id]: models });
  await startSession(
    targetWorktreeId,
    agent,
    link.message ?? undefined,
    resolved.agentId === agent.id ? resolved.selection : EMPTY_MODEL_SELECTION,
  );
}

/** Shared dependencies for running/stopping a project's interactive script tabs. */
interface ManagedScriptRunContext {
  projectId: string;
  worktreeId: string;
  cwd: string;
  scriptName: string;
  dispatch: (action: WorkspaceAction) => void;
  setManagedScriptsState: Dispatch<SetStateAction<ManagedScriptsState>>;
  splitRootByWorktree: WorkspaceState["splitRootByWorktree"];
  closeTab: (tabId: string) => Promise<unknown>;
  /** Push order of scripts that have overwritten the worktree's split root, oldest first. */
  layoutStackRef: RefObject<Record<string, string[]>>;
}

/** Capitalizes a script name for a terminal tab title (`lint` -> `Lint`). */
function scriptTabTitle(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Creates one script tab, registers it, and records progress in the managed-scripts state. */
async function createScriptTabForCommand(
  ctx: ManagedScriptRunContext,
  commandIndex: number,
  tabIdsByCommand: string[],
  startedTabIds: string[],
  splitSnapshot: RunScriptsSplitSnapshot | null,
): Promise<void> {
  const tab = await createTabCommand(
    ctx.projectId,
    ctx.worktreeId,
    "terminal",
    scriptTabTitle(ctx.scriptName),
  );
  startedTabIds.push(tab.id);
  tabIdsByCommand[commandIndex] = tab.id;
  ctx.dispatch({ type: "add-tab", tab, focus: false });
  // Unfocused tabs never render (only the active tab per pane mounts), so
  // mount into an off-screen host now to spawn the PTY immediately. It's kept
  // in the document (not display:none) so xterm can still measure it.
  // TerminalView re-parents this same terminal instance into the real DOM
  // once the tab is actually viewed, instead of creating a second one.
  const offscreenHost = document.createElement("div");
  offscreenHost.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:80ch;height:24em;";
  document.body.append(offscreenHost);
  const hostGeneration = terminalManager.mount(tab, ctx.cwd, offscreenHost);
  offscreenHost.remove();
  terminalManager.park(tab.id, hostGeneration);
  // Script tabs are unattended (no one is sitting at the terminal to close
  // them), so a script that finishes or crashes on its own must close its
  // own tab; closeTab already drops the tab from managedScriptsState and
  // resets the run/build button to inactive once no tabs are left.
  terminalManager.onExit(tab.id, () => void ctx.closeTab(tab.id));
  ctx.setManagedScriptsState((current) => ({
    ...current,
    [ctx.worktreeId]: {
      ...current[ctx.worktreeId],
      [ctx.scriptName]: {
        name: ctx.scriptName,
        worktreeId: ctx.worktreeId,
        tabIds: [...startedTabIds],
        stopping: false,
        splitSnapshot,
      },
    },
  }));
}

/** Applies one plan item's split layout, capturing the pre-split snapshot on first use. */
function applyRunScriptItemLayout(
  item: PlannedRunScripts["items"][number],
  splitSnapshot: RunScriptsSplitSnapshot | null,
  ctx: ManagedScriptRunContext,
  tabIdsByCommand: string[],
): RunScriptsSplitSnapshot | null {
  if (!item.layout) {
    return splitSnapshot;
  }
  const snapshot =
    splitSnapshot ??
    ({
      root:
        ctx.worktreeId in ctx.splitRootByWorktree
          ? (ctx.splitRootByWorktree[ctx.worktreeId] ?? null)
          : null,
    } satisfies RunScriptsSplitSnapshot);
  if (!splitSnapshot) {
    const stack = ctx.layoutStackRef.current[ctx.worktreeId] ?? [];
    ctx.layoutStackRef.current = {
      ...ctx.layoutStackRef.current,
      [ctx.worktreeId]: [...stack, ctx.scriptName],
    };
  }
  ctx.dispatch({
    type: "set-split-root",
    worktreeId: ctx.worktreeId,
    root: materializeRunScriptLayout(item.layout, tabIdsByCommand),
  });
  return snapshot;
}

/** Writes each queued command into its terminal once the shell has had time to start. */
function flushScriptCommands(
  item: PlannedRunScripts["items"][number],
  plan: PlannedRunScripts,
  tabIdsByCommand: string[],
): void {
  for (const commandIndex of item.commandIndexes) {
    const tabId = tabIdsByCommand[commandIndex];
    const command = plan.commands[commandIndex];
    if (tabId && command) {
      // The tab's shell only ever emits a PTY "exit" when the shell itself
      // exits, not when a typed-in command finishes (the shell just returns
      // to its prompt). Chaining `exit $?` makes the shell terminate the
      // moment the script command does (with its exit code), so the "exit"
      // event that closeTab listens for actually fires.
      terminalManager.writeWhenReady(tabId, `${command}; exit $?\r`);
    }
  }
}

/** Runs the planned script tabs/splits, returning the captured split snapshot. */
async function runManagedScriptPlan(
  ctx: ManagedScriptRunContext,
  config: Awaited<ReturnType<typeof loadProjectScripts>>,
  startedTabIds: string[],
): Promise<RunScriptsSplitSnapshot | null> {
  const entries = config.runScripts?.[ctx.scriptName]?.command ?? [];
  if (entries.length === 0) {
    toast.info(`No ${ctx.scriptName} scripts configured for this project`);
    return null;
  }
  const plan = planInteractiveScripts(entries, ctx.scriptName);
  const tabIdsByCommand: string[] = [];
  let splitSnapshot: RunScriptsSplitSnapshot | null = null;
  for (const item of plan.items) {
    for (const commandIndex of item.commandIndexes) {
      // oxlint-disable-next-line no-await-in-loop -- Create script tabs in display order so each top-level tab can mount before command injection.
      await createScriptTabForCommand(
        ctx,
        commandIndex,
        tabIdsByCommand,
        startedTabIds,
        splitSnapshot,
      );
    }
    splitSnapshot = applyRunScriptItemLayout(item, splitSnapshot, ctx, tabIdsByCommand);
    // oxlint-disable-next-line no-await-in-loop -- Each script entry needs one paint after its tabs/split are in state, then time for the PTY shell to start, before queued terminal input flushes.
    await nextAnimationFrame();
    // oxlint-disable-next-line no-await-in-loop -- Same reasoning as above: must elapse before this entry's queued terminal input flushes.
    await delay(INTERACTIVE_SCRIPT_START_DELAY_MS);
    flushScriptCommands(item, plan, tabIdsByCommand);
  }
  return splitSnapshot;
}

/** Cleans up partial script tabs and restores the split on a mid-run failure. */
async function handleManagedScriptsFailure(
  ctx: ManagedScriptRunContext,
  splitSnapshot: RunScriptsSplitSnapshot | null,
  startedTabIds: string[],
  cause: unknown,
): Promise<void> {
  ctx.setManagedScriptsState((current) => {
    const scripts = current[ctx.worktreeId];
    if (!scripts) {
      return current;
    }
    const { [ctx.scriptName]: _, ...remaining } = scripts;
    if (Object.keys(remaining).length > 0) {
      return { ...current, [ctx.worktreeId]: remaining };
    }
    const { [ctx.worktreeId]: __, ...rest } = current;
    return rest;
  });
  if (splitSnapshot) {
    popScriptLayout(
      ctx.dispatch,
      ctx.setManagedScriptsState,
      ctx.layoutStackRef,
      ctx.worktreeId,
      ctx.scriptName,
      splitSnapshot,
    );
  }
  await Promise.all(startedTabIds.map((tabId) => ctx.closeTab(tabId)));
  toast.error(`Failed to run project ${ctx.scriptName} scripts: ${errorMessage(cause)}`);
}

/** Records the location to offer "Go back" to before navigating away. */
function recordAgentBackLocation(
  current: WorkspaceState,
  setAgentBackLocation: (location: AgentBackLocation | null) => void,
): void {
  const projectId = current.selectedProjectId;
  if (!projectId) {
    return;
  }
  const currentWorktreeId = current.selectedWorktreeByProject[projectId];
  if (!currentWorktreeId) {
    return;
  }
  // `activeTabByWorktree` is only written by an explicit tab switch, so fall
  // back to the worktree's first tab (matching `isTabCurrentlyViewed`) —
  // otherwise a jump from a worktree the user never re-tabbed records no
  // back location and the "Go back" button never appears.
  const currentTabId =
    current.activeTabByWorktree[currentWorktreeId] ??
    current.tabs.find((tab) => tab.worktreeId === currentWorktreeId)?.id ??
    null;
  if (currentTabId) {
    setAgentBackLocation({
      projectId,
      worktreeId: currentWorktreeId,
      tabId: currentTabId,
      expiresAt: Date.now() + AGENT_BACK_TTL_MS,
    });
  }
}

/** Loads a project's worktrees, tabs, and splits after selecting it. */
async function loadProjectWorkspace(
  projectId: string,
  dispatch: (action: WorkspaceAction) => void,
): Promise<Tab[]> {
  dispatch({ type: "select-project", projectId });
  const [worktrees, tabs, splits] = await Promise.all([
    listWorktrees(projectId),
    listTabs(projectId),
    listSplits(projectId),
  ]);
  dispatch({ type: "set-worktrees", projectId, worktrees });
  dispatch({ type: "set-tabs", tabs });
  dispatch({ type: "set-splits", projectId, worktreeRoots: parseStoredSplits(splits) });
  return tabs;
}

/** Resolves the owning project for a new tab from an explicit worktree, then the selection. */
function resolveCreateTabProject(
  worktreeId: string | undefined,
  worktreeProjectId: Record<string, string>,
  selectedProjectId: string | null,
): string | null {
  return (worktreeId ? worktreeProjectId[worktreeId] : undefined) ?? selectedProjectId ?? null;
}

/** Resolves the worktree a new tab lives in, falling back to the project's selection. */
function resolveCreateTabWorktreeId(
  worktreeId: string | undefined,
  projectId: string | null,
  selectedWorktreeByProject: Record<string, string>,
): string | undefined {
  return worktreeId ?? (projectId ? selectedWorktreeByProject[projectId] : undefined);
}

/** Creates a terminal or browser tab via the Tauri command. */
async function createTabOfKind(
  kind: "terminal" | "browser",
  projectId: string,
  worktreeId: string,
): Promise<Tab> {
  return kind === "terminal"
    ? await createTabCommand(projectId, worktreeId, "terminal", defaultTabTitle("terminal"))
    : await createTabCommand(
        projectId,
        worktreeId,
        "browser",
        defaultTabTitle("browser"),
        BROWSER_START_URL,
      );
}

/** Dispatches a newly created tab into a pane (when given) or the top bar. */
function dispatchNewTab(
  dispatch: (action: WorkspaceAction) => void,
  tab: Tab,
  paneId: string | null,
): void {
  dispatch(paneId ? { type: "add-tab-to-pane", tab, paneId } : { type: "add-tab", tab });
}

/** Handlers needed to react to a single agent status report. */
interface AgentReportContext {
  visibleTabIdsRef: RefObject<Set<string>>;
  applySessionName: (payload: AgentReportPayload) => void;
  clearDoneStatusForTab: (tabId: string) => void;
  markAgentsSeen: (tabId: string) => Promise<void>;
  latchAlertedStatus: (payload: AgentReportPayload) => void;
  releaseAlertLatch: (payload: AgentReportPayload) => void;
  isTabCurrentlyViewed: (tabId: string) => boolean;
  shouldAlertForStatus: (payload: AgentReportPayload) => boolean;
  resolveProjectForWorktree: (worktreeId: string) => Promise<string | null>;
  describeAgentLocation: (
    projectId: string | null,
    worktreeId: string,
    tabId: string,
  ) => AgentAlertLocation;
  navigateToAgentLocation: (projectId: string, worktreeId: string, tabId: string) => void;
  alertAgent: (payload: AgentReportPayload, options?: AgentAlertOptions) => Promise<void>;
}

/** Releases the alert latch when the agent moves on (new turn or process exit). */
function releaseLatchOnAgentMove(
  payload: AgentReportPayload,
  releaseAlertLatchFn: (payload: AgentReportPayload) => void,
): void {
  if (payload.status === "running" || payload.status === "cleared") {
    releaseAlertLatchFn(payload);
  }
}

/** Latches a completion/attention seen on screen, dropping the green dot for `done`. */
function latchSeenAgentCompletion(payload: AgentReportPayload, ctx: AgentReportContext): void {
  if (
    (payload.status === "done" || payload.status === "attention") &&
    ctx.visibleTabIdsRef.current.has(payload.tabId)
  ) {
    // For `done` also drop the green dot immediately instead of flashing it;
    // `attention` (red) keeps showing until the agent moves on.
    if (payload.status === "done") {
      ctx.clearDoneStatusForTab(payload.tabId);
      // Tell the daemon this completion was seen so its stored `done` is dropped —
      // otherwise a later reconnect would replay it and the green dot (and
      // notification) would come back.
      void ctx.markAgentsSeen(payload.tabId);
    }
    ctx.latchAlertedStatus(payload);
  }
}

/** Alerts an unseen attention/done at most once per status occurrence. */
function alertUnseenAgentStatus(payload: AgentReportPayload, ctx: AgentReportContext): void {
  if (
    !ctx.isTabCurrentlyViewed(payload.tabId) &&
    (payload.status === "attention" || payload.status === "done") &&
    ctx.shouldAlertForStatus(payload)
  ) {
    ctx.latchAlertedStatus(payload);
    void ctx.resolveProjectForWorktree(payload.worktreeId).then((projectId) => {
      const onGoTo = projectId
        ? () => void ctx.navigateToAgentLocation(projectId, payload.worktreeId, payload.tabId)
        : undefined;
      void ctx.alertAgent(payload, {
        projectId: projectId ?? undefined,
        location: ctx.describeAgentLocation(projectId, payload.worktreeId, payload.tabId),
        onGoTo,
      });
      return undefined;
    });
  }
}

/** Delay between a `.pragma/scripts.json` change event and the config reload, coalescing bursts. */
const SCRIPTS_CONFIG_RELOAD_DEBOUNCE_MS = 200;

/**
 * Loads (and reloads) the active project's `.pragma/scripts.json` config + error.
 * Watches the file through the project's main worktree so edits apply live,
 * without reopening the project.
 */
function useProjectScriptsConfig(
  selectedProjectId: string | null,
  mainWorktreeId: string | null,
): {
  runScriptsConfig: ProjectScriptsConfig | null;
  runScriptsConfigError: string | null;
  setRunScriptsConfig: (config: ProjectScriptsConfig | null) => void;
  setRunScriptsConfigError: (error: string | null) => void;
} {
  const [runScriptsConfig, setRunScriptsConfig] = useState<ProjectScriptsConfig | null>(null);
  const [runScriptsConfigError, setRunScriptsConfigError] = useState<string | null>(null);
  useEffect(() => {
    setRunScriptsConfig(null);
    setRunScriptsConfigError(null);
    if (!selectedProjectId) {
      return;
    }
    let cancelled = false;
    // `notifyOnError` is set for watcher-triggered reloads: the user just
    // edited the file, so surface a broken config as a toast instead of only
    // the script buttons' tooltip.
    const load = (notifyOnError: boolean) =>
      loadProjectScripts(selectedProjectId)
        .then((config) => {
          if (!cancelled) {
            setRunScriptsConfig(config);
            setRunScriptsConfigError(null);
          }
          return undefined;
        })
        .catch((cause) => {
          if (!cancelled) {
            setRunScriptsConfig(null);
            setRunScriptsConfigError(errorMessage(cause));
            if (notifyOnError) {
              toast.error(`Failed to reload project scripts: ${errorMessage(cause)}`);
            }
          }
          return undefined;
        });
    void load(false);
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = mainWorktreeId
      ? subscribeToWorktreeFiles(mainWorktreeId, (change) => {
          if (change.path !== constants.scripts.configPath) {
            return;
          }
          if (reloadTimer !== null) {
            clearTimeout(reloadTimer);
          }
          reloadTimer = setTimeout(() => void load(true), SCRIPTS_CONFIG_RELOAD_DEBOUNCE_MS);
        })
      : null;
    return () => {
      cancelled = true;
      if (reloadTimer !== null) {
        clearTimeout(reloadTimer);
      }
      unsubscribe?.();
    };
  }, [selectedProjectId, mainWorktreeId]);
  return { runScriptsConfig, runScriptsConfigError, setRunScriptsConfig, setRunScriptsConfigError };
}

/** Subscribes to native browser/terminal metadata and mirrors it into tab state. */
function useTabMetaListeners(
  dispatch: (action: WorkspaceAction) => void,
  tabsRef: RefObject<Tab[]>,
  terminalTabIdsKey: string,
  setActiveTabRef: RefObject<(tabId: string | null) => void>,
): void {
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
  }, [dispatch]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onBrowserFocusRequest((request) => setActiveTabRef.current(request.tabId))
      .then((stop) => (unlisten = stop))
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [setActiveTabRef]);

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
          if (
            !currentTab ||
            currentTab.kind !== "terminal" ||
            currentTab.userRenamed ||
            currentTab.agentId
          ) {
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
  }, [dispatch, terminalTabIdsKey, tabsRef]);
}

/** Wires the non-React terminal link providers to workspace open actions. */
function useTerminalLinkHandler(
  openFromTerminalLink: (
    sourceTabId: string,
    worktreeId: string,
    spec: { kind: "browser"; url: string } | { kind: "editor"; path: string },
  ) => Promise<void>,
): void {
  useEffect(() => {
    setTerminalLinkHandler({
      openUrl: ({ tabId, worktreeId, url, external }) => {
        if (external) {
          void browserOpenExternal(url).catch((cause) => toast.error(errorMessage(cause)));
          return;
        }
        void openFromTerminalLink(tabId, worktreeId, { kind: "browser", url });
      },
      openFile: ({ tabId, worktreeId, path }) => {
        void openFromTerminalLink(tabId, worktreeId, { kind: "editor", path });
      },
      pathExists: (worktreeId, path) => pathExists(worktreeId, path).catch(() => false),
    });
    return () => setTerminalLinkHandler(null);
  }, [openFromTerminalLink]);
}

type WorkspaceDispatch = (action: WorkspaceAction) => void;

/** Holds the latest workspace state + derived lookup refs for async callbacks. */
function useWorkspaceRefs(state: WorkspaceState): {
  stateRef: RefObject<WorkspaceState>;
  tabsRef: RefObject<Tab[]>;
  selectedProjectIdRef: RefObject<string | null>;
  worktreeProjectIdRef: RefObject<Record<string, string>>;
  didHydrateRef: RefObject<boolean>;
  lastPersistedRef: RefObject<string | null>;
} {
  const stateRef = useRef(state);
  stateRef.current = state;
  const tabsRef = useRef(state.tabs);
  tabsRef.current = state.tabs;
  const selectedProjectIdRef = useRef(state.selectedProjectId);
  selectedProjectIdRef.current = state.selectedProjectId;
  const worktreeProjectIdRef = useRef<Record<string, string>>({});
  worktreeProjectIdRef.current = Object.fromEntries(
    Object.entries(state.worktrees).flatMap(([projectId, worktrees]) =>
      worktrees.map((worktree) => [worktree.id, projectId]),
    ),
  );
  const didHydrateRef = useRef(false);
  const lastPersistedRef = useRef<string | null>(null);
  return {
    stateRef,
    tabsRef,
    selectedProjectIdRef,
    worktreeProjectIdRef,
    didHydrateRef,
    lastPersistedRef,
  };
}

/** Agent "go back" location + activate/navigate/go-back actions. */
function useAgentNavigation(
  stateRef: RefObject<WorkspaceState>,
  dispatch: WorkspaceDispatch,
): {
  agentBackLocation: AgentBackLocation | null;
  setAgentBackLocation: (location: AgentBackLocation | null) => void;
  activateLocation: (
    projectId: string,
    worktreeId: string,
    tabId: string,
    recordBack: boolean,
  ) => Promise<void>;
  navigateToAgentLocation: (projectId: string, worktreeId: string, tabId: string) => Promise<void>;
  goBackFromAgent: () => Promise<void>;
} {
  const [agentBackLocation, setAgentBackLocation] = useState<AgentBackLocation | null>(null);

  const activateLocation = useCallback(
    async (projectId: string, worktreeId: string, tabId: string, recordBack: boolean) => {
      if (recordBack) {
        recordAgentBackLocation(stateRef.current, setAgentBackLocation);
      }
      if (stateRef.current.selectedProjectId !== projectId) {
        await loadProjectWorkspace(projectId, dispatch);
      }
      dispatch({ type: "select-worktree", projectId, worktreeId });
      dispatch({ type: "set-active-tab", worktreeId, tabId });
    },
    [dispatch, stateRef],
  );

  const navigateToAgentLocation = useCallback(
    (projectId: string, worktreeId: string, tabId: string) =>
      activateLocation(projectId, worktreeId, tabId, true),
    [activateLocation],
  );

  const goBackFromAgent = useCallback(async () => {
    const location = agentBackLocation;
    if (!location || location.expiresAt < Date.now()) {
      setAgentBackLocation(null);
      return;
    }
    setAgentBackLocation(null);
    await activateLocation(location.projectId, location.worktreeId, location.tabId, false);
  }, [activateLocation, agentBackLocation]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setAgentBackLocation((location) =>
        location && location.expiresAt < Date.now() ? null : location,
      );
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return {
    agentBackLocation,
    setAgentBackLocation,
    activateLocation,
    navigateToAgentLocation,
    goBackFromAgent,
  };
}

/**
 * A tab's own name, or null while it still carries the default title for its kind
 * ("Shell") — which says nothing the worktree name in the alert does not.
 */
function namedTabTitle(tab: Tab | undefined): string | null {
  if (!tab) {
    return null;
  }
  const title = tab.title?.trim();
  return title && title !== defaultTabTitle(tab.kind) ? title : null;
}

/** Resolves the owning project for a worktree id (lazy-loading projects as needed). */
function useWorktreeResolution(
  stateRef: RefObject<WorkspaceState>,
  worktreeProjectIdRef: RefObject<Record<string, string>>,
  dispatch: WorkspaceDispatch,
): {
  resolveProjectForWorktree: (worktreeId: string) => Promise<string | null>;
  describeAgentLocation: (
    projectId: string | null,
    worktreeId: string,
    tabId: string,
  ) => AgentAlertLocation;
  isTabCurrentlyViewed: (tabId: string) => boolean;
} {
  const resolveProjectForWorktree = useCallback(
    async (worktreeId: string) => {
      const known = worktreeProjectIdRef.current[worktreeId];
      if (known) {
        return known;
      }
      const projects = await listProjects();
      dispatch({ type: "set-projects", projects });
      const projectWorktrees = await Promise.all(
        projects.map(async (project) => ({ project, worktrees: await listWorktrees(project.id) })),
      );
      for (const { project, worktrees } of projectWorktrees) {
        dispatch({ type: "set-worktrees", projectId: project.id, worktrees });
        if (worktrees.some((worktree) => worktree.id === worktreeId)) {
          return project.id;
        }
      }
      return null;
    },
    [dispatch, worktreeProjectIdRef],
  );

  const describeAgentLocation = useCallback(
    (projectId: string | null, worktreeId: string, tabId: string): AgentAlertLocation => {
      const current = stateRef.current;
      const worktree = Object.values(current.worktrees)
        .flat()
        .find((candidate) => candidate.id === worktreeId);
      return {
        projectName: current.projects.find((project) => project.id === projectId)?.name ?? null,
        worktreeName: worktree ? (worktree.title ?? worktree.branch) : null,
        tabName: namedTabTitle(current.tabs.find((tab) => tab.id === tabId)),
      };
    },
    [stateRef],
  );

  const isTabCurrentlyViewed = useCallback(
    (tabId: string) => {
      const current = stateRef.current;
      const projectId = current.selectedProjectId;
      const worktreeId = projectId ? current.selectedWorktreeByProject[projectId] : null;
      if (!worktreeId) {
        return false;
      }
      const activeTabId =
        current.activeTabByWorktree[worktreeId] ??
        current.tabs.find((tab) => tab.worktreeId === worktreeId)?.id ??
        null;
      return activeTabId === tabId;
    },
    [stateRef],
  );

  return { resolveProjectForWorktree, describeAgentLocation, isTabCurrentlyViewed };
}

/** Subscribes to agent status/reset/cli-path/notification events and routes them. */
function useAgentStatusListeners(
  reportCtx: Omit<AgentReportContext, "visibleTabIdsRef"> & {
    visibleTabIdsRef: RefObject<Set<string>>;
  },
): void {
  const { navigateToAgentLocation } = reportCtx;
  useEffect(() => {
    let cancelled = false;
    let unlistenReport: (() => void) | null = null;
    let unlistenMessage: (() => void) | null = null;
    let unlistenReset: (() => void) | null = null;
    let unlistenPath: (() => void) | null = null;
    let unlistenNotificationClick: (() => void) | null = null;
    void onAgentStatusReset(() => {
      clearAllAgentStatuses();
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return undefined;
      }
      unlistenReset = unlisten;
      return undefined;
    });
    void onAgentReport((payload) => {
      reportCtx.applySessionName(payload);
      if (!payload.status) {
        // A status-less report (session-name only) carries no indicator change.
        return;
      }
      applyAgentReport(payload);
      releaseLatchOnAgentMove(payload, reportCtx.releaseAlertLatch);
      latchSeenAgentCompletion(payload, reportCtx);
      alertUnseenAgentStatus(payload, reportCtx);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return undefined;
      }
      unlistenReport = unlisten;
      return undefined;
    });
    void onAgentMessage((payload) => {
      applyAgentMessage(payload);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return undefined;
      }
      unlistenMessage = unlisten;
      return undefined;
    });
    void onAgentCliPathWarning((path) => {
      toast.warning("pragma-cli installed, but its directory is not on PATH", {
        description: `Add ${path} to PATH so agents can call pragma-cli.`,
      });
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return undefined;
      }
      unlistenPath = unlisten;
      return undefined;
    });
    void onAgentNotificationClick((payload) => {
      void navigateToAgentLocation(payload.projectId, payload.worktreeId, payload.tabId);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return undefined;
      }
      unlistenNotificationClick = unlisten;
      return undefined;
    });
    return () => {
      cancelled = true;
      unlistenReport?.();
      unlistenMessage?.();
      unlistenReset?.();
      unlistenPath?.();
      unlistenNotificationClick?.();
    };
    // reportCtx fields are stable callbacks/refs; only navigateToAgentLocation
    // is a real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigateToAgentLocation]);
}

/** Project + worktree selection actions (reload/hydrate, select, refresh). */
function useProjectSelection(
  state: WorkspaceState,
  dispatch: WorkspaceDispatch,
  refs: {
    didHydrateRef: RefObject<boolean>;
    lastPersistedRef: RefObject<string | null>;
    selectedProjectIdRef: RefObject<string | null>;
    worktreeProjectIdRef: RefObject<Record<string, string>>;
  },
  setAgentBackLocation: (location: AgentBackLocation | null) => void,
): {
  reload: () => Promise<void>;
  selectProject: (projectId: string | null) => Promise<void>;
  refreshProject: (projectId?: string | null) => Promise<void>;
  selectWorktree: (worktreeId: string | null) => void;
} {
  const { didHydrateRef, lastPersistedRef, selectedProjectIdRef, worktreeProjectIdRef } = refs;
  const reload = useCallback(async () => {
    dispatch({ type: "load-start" });
    try {
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
      dispatch({ type: "load-error", error: errorMessage(cause) });
    }
  }, [didHydrateRef, dispatch, lastPersistedRef]);

  const selectProject = useCallback(
    async (projectId: string | null) => {
      // Navigating manually retires the agent "go back" affordance — it only
      // makes sense right after a notification jumped you somewhere.
      setAgentBackLocation(null);
      dispatch({ type: "select-project", projectId });
    },
    [dispatch, setAgentBackLocation],
  );

  const refreshProject = useCallback(
    async (projectId?: string | null) => {
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
        dispatch({
          type: "set-splits",
          projectId: targetProjectId,
          worktreeRoots: parseStoredSplits(splits),
        });
      } catch (cause) {
        dispatch({ type: "load-error", error: errorMessage(cause) });
        throw cause;
      }
    },
    [dispatch, selectedProjectIdRef],
  );

  const selectWorktree = useCallback(
    (worktreeId: string | null, explicitProjectId?: string) => {
      if (!worktreeId) {
        return;
      }
      // Resolve the owning project from the worktree (ref, so it's correct for a
      // worktree in a project other than the captured selection — e.g. a deep
      // link), falling back to the current selection.
      const projectId =
        explicitProjectId ?? worktreeProjectIdRef.current[worktreeId] ?? state.selectedProjectId;
      if (!projectId) {
        return;
      }
      // Navigating manually retires the agent "go back" affordance — it only
      // makes sense right after a notification jumped you somewhere.
      setAgentBackLocation(null);
      dispatch({ type: "select-worktree", projectId, worktreeId });
    },
    [dispatch, setAgentBackLocation, state.selectedProjectId, worktreeProjectIdRef],
  );

  return { reload, selectProject, refreshProject, selectWorktree };
}

/** Finds an existing browser tab matching a terminal link's URL. */
function findExistingBrowserTab(tabs: Tab[], worktreeId: string, url: string): Tab | undefined {
  return tabs.find(
    (tab) => tab.kind === "browser" && tab.worktreeId === worktreeId && tab.url === url,
  );
}

/** Finds an existing editor tab matching a terminal link's worktree-relative path. */
function findExistingEditorTab(tabs: Tab[], worktreeId: string, path: string): Tab | undefined {
  return tabs.find(
    (tab) =>
      tab.kind === "editor" &&
      tab.worktreeId === worktreeId &&
      tab.filePath === path &&
      tab.diffSide === null,
  );
}

/** Creates the tab record for a terminal link target (browser URL or editor path). */
async function createLinkTab(
  spec: { kind: "browser"; url: string } | { kind: "editor"; path: string },
  projectId: string,
  worktreeId: string,
): Promise<Tab> {
  if (spec.kind === "browser") {
    return createTabCommand(projectId, worktreeId, "browser", defaultTabTitle("browser"), spec.url);
  }
  return createTabCommand(
    projectId,
    worktreeId,
    "editor",
    basename(spec.path),
    undefined,
    spec.path,
    null,
  );
}

/** Shared tab-creation path + the convenience per-kind and per-pane wrappers. */
function useTabCreation(
  state: WorkspaceState,
  dispatch: WorkspaceDispatch,
  worktreeProjectIdRef: RefObject<Record<string, string>>,
  selectedProjectIdRef: RefObject<string | null>,
): {
  createTab: (
    kind: "terminal" | "browser",
    paneId: string | null,
    worktreeId?: string,
    options?: WorktreeTargetOptions,
  ) => Promise<Tab | null>;
  createTerminalTab: (worktreeId?: string, options?: WorktreeTargetOptions) => Promise<Tab | null>;
  createBrowserTab: (worktreeId?: string) => Promise<Tab | null>;
  createTabInPane: (paneId: string, kind: "terminal" | "browser") => Promise<void>;
} {
  const createTab = useCallback(
    async (
      kind: "terminal" | "browser",
      paneId: string | null,
      worktreeId?: string,
      options?: WorktreeTargetOptions,
    ) => {
      const projectId =
        options?.projectId ??
        resolveCreateTabProject(worktreeId, worktreeProjectIdRef.current, state.selectedProjectId);
      const targetWorktreeId = resolveCreateTabWorktreeId(
        worktreeId,
        projectId,
        state.selectedWorktreeByProject,
      );
      if (!projectId || !targetWorktreeId) {
        return null;
      }
      try {
        const tab = await createTabOfKind(kind, projectId, targetWorktreeId);
        // The workspace only keeps tabs for its selected project. A background
        // creation may finish after its owner is no longer selected.
        if (selectedProjectIdRef.current === projectId) {
          dispatchNewTab(dispatch, tab, paneId);
        }
        return tab;
      } catch (cause) {
        dispatch({ type: "load-error", error: errorMessage(cause) });
        return null;
      }
    },
    [
      dispatch,
      selectedProjectIdRef,
      state.selectedProjectId,
      state.selectedWorktreeByProject,
      worktreeProjectIdRef,
    ],
  );

  const createTerminalTab = useCallback(
    (worktreeId?: string, options?: WorktreeTargetOptions) =>
      createTab("terminal", null, worktreeId, options),
    [createTab],
  );
  const createBrowserTab = useCallback(
    (worktreeId?: string) => createTab("browser", null, worktreeId),
    [createTab],
  );
  const createTabInPane = useCallback(
    async (paneId: string, kind: "terminal" | "browser") => {
      await createTab(kind, paneId);
    },
    [createTab],
  );
  return { createTab, createTerminalTab, createBrowserTab, createTabInPane };
}

/** Launches an agent thread: switch worktree, open a terminal tab, start the agent. */
function useSessionLaunch(
  selectWorktree: (worktreeId: string | null, projectId?: string) => void,
  createTerminalTab: (worktreeId?: string, options?: WorktreeTargetOptions) => Promise<Tab | null>,
  markTabAgent: (tabId: string, agent: AgentConfig) => Promise<void>,
): (
  worktreeId: string,
  agent: AgentConfig,
  message?: string,
  modelSelection?: AgentModelSelection,
  options?: WorktreeTargetOptions,
) => Promise<Tab | null> {
  return useCallback(
    async (
      worktreeId: string,
      agent: AgentConfig,
      message?: string,
      modelSelection?: AgentModelSelection,
      options?: WorktreeTargetOptions,
    ): Promise<Tab | null> => {
      selectWorktree(worktreeId, options?.projectId);
      const tab = await createTerminalTab(worktreeId, options);
      if (!tab) {
        return null;
      }
      void markTabAgent(tab.id, agent);
      startAgentInTab(tab.id, agent, message, modelSelection);
      return tab;
    },
    [createTerminalTab, markTabAgent, selectWorktree],
  );
}

/** Handles `pragma://open` deep links: subscribe live + drain any cold-start URL. */
function useDeepLinkHandler(
  stateRef: RefObject<WorkspaceState>,
  resolveProjectForWorktree: (worktreeId: string) => Promise<string | null>,
  selectProject: (projectId: string | null) => Promise<void>,
  selectWorktree: (worktreeId: string | null) => void,
  startSession: (
    worktreeId: string,
    agent: AgentConfig,
    message?: string,
    modelSelection?: AgentModelSelection,
  ) => Promise<Tab | null>,
): void {
  const handleDeepLink = useCallback(
    async (rawUrl: string) => {
      const link = parseNewSessionDeepLink(rawUrl);
      if (!link) {
        const pluginLink = parsePluginDeepLink(rawUrl);
        if (pluginLink) {
          requestPluginDeepLink(pluginLink);
        }
        return;
      }
      const worktreeId = await resolveDeepLinkWorktreeSelection(
        link,
        resolveProjectForWorktree,
        selectProject,
        selectWorktree,
      );
      const targetWorktreeId = resolveDeepLinkTargetWorktree(stateRef.current, worktreeId);
      if (
        await autoSubmitDeepLink(
          link,
          targetWorktreeId,
          () => Promise.resolve(listPluginAgents()),
          async (agentId) => (await resolvePluginAgentModels(agentId)) ?? [],
          startSession,
        )
      ) {
        return;
      }
      requestNewSession({
        agentId: link.agentId,
        modelId: link.modelId,
        reasoningId: link.reasoningId,
        worktreeId: targetWorktreeId,
        message: link.message,
      });
    },
    [resolveProjectForWorktree, selectProject, selectWorktree, startSession, stateRef],
  );
  const handleDeepLinkRef = useRef(handleDeepLink);
  handleDeepLinkRef.current = handleDeepLink;
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onDeepLink((url) => void handleDeepLinkRef.current(url))
      .then((stop) => (unlisten = stop))
      .catch(() => undefined);
    void takePendingDeepLink()
      .then((url) => {
        if (url) {
          void handleDeepLinkRef.current(url);
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, []);
}

/** Opens a terminal-link target in a split right of the clicked terminal (deduped). */
function useTerminalLinkOpener(
  dispatch: WorkspaceDispatch,
  worktreeProjectIdRef: RefObject<Record<string, string>>,
  selectedProjectIdRef: RefObject<string | null>,
  tabsRef: RefObject<Tab[]>,
): (
  sourceTabId: string,
  worktreeId: string,
  spec: { kind: "browser"; url: string } | { kind: "editor"; path: string },
) => Promise<void> {
  return useCallback(
    async (
      sourceTabId: string,
      worktreeId: string,
      spec: { kind: "browser"; url: string } | { kind: "editor"; path: string },
    ) => {
      const projectId = worktreeProjectIdRef.current[worktreeId] ?? selectedProjectIdRef.current;
      if (!projectId) {
        return;
      }
      const existing =
        spec.kind === "browser"
          ? findExistingBrowserTab(tabsRef.current, worktreeId, spec.url)
          : findExistingEditorTab(tabsRef.current, worktreeId, spec.path);
      if (existing) {
        dispatch({ type: "set-active-tab", worktreeId, tabId: existing.id });
        return;
      }
      try {
        const tab = await createLinkTab(spec, projectId, worktreeId);
        dispatch({
          type: "open-in-new-split",
          tab,
          sourceTabId,
          direction: "horizontal",
          placement: "after",
        });
      } catch (cause) {
        dispatch({ type: "load-error", error: errorMessage(cause) });
      }
    },
    [dispatch, selectedProjectIdRef, tabsRef, worktreeProjectIdRef],
  );
}

/** The project/worktree pair a new tab would be created under, or `null` when none is selected. */
function activeTabTarget(
  selectedProjectId: string | null,
  selectedWorktreeByProject: Record<string, string>,
): TabTarget | null {
  const projectId = selectedProjectId;
  const worktreeId = projectId ? selectedWorktreeByProject[projectId] : undefined;
  return projectId && worktreeId ? { projectId, worktreeId } : null;
}

/** The project/worktree a tab is created under. */
type TabTarget = { projectId: string; worktreeId: string };

/** One deduped tab-open: focus a matching tab, otherwise create one and add it. */
type OpenDedupedTabRequest = {
  /** Matches an already-open tab that should be focused instead of creating a new one. */
  match: (tab: Tab, target: TabTarget) => boolean;
  create: (target: TabTarget) => Promise<Tab>;
  paneId?: string;
  /** When set, a missing worktree throws with this message instead of silently returning. */
  requireTargetError?: string;
  /** Rethrow creation failures after reporting them, for callers that await success. */
  rethrow?: boolean;
};

/**
 * Shared open-or-focus flow behind every tab opener: resolve the active worktree, focus a
 * matching tab if one exists, otherwise create the tab and dispatch it into the workspace.
 */
function useOpenDedupedTab(
  state: WorkspaceState,
  dispatch: WorkspaceDispatch,
): (request: OpenDedupedTabRequest) => Promise<void> {
  const { selectedProjectId, selectedWorktreeByProject, tabs } = state;
  return useCallback(
    async ({ match, create, paneId, requireTargetError, rethrow }: OpenDedupedTabRequest) => {
      const target = activeTabTarget(selectedProjectId, selectedWorktreeByProject);
      if (!target) {
        if (requireTargetError) throw new Error(requireTargetError);
        return;
      }
      const existing = tabs.find((tab) => match(tab, target));
      if (existing) {
        dispatch({ type: "set-active-tab", worktreeId: existing.worktreeId, tabId: existing.id });
        return;
      }
      try {
        const tab = await create(target);
        dispatch(paneId ? { type: "add-tab-to-pane", tab, paneId } : { type: "add-tab", tab });
      } catch (cause) {
        dispatch({ type: "load-error", error: errorMessage(cause) });
        if (rethrow) throw cause;
      }
    },
    [dispatch, selectedProjectId, selectedWorktreeByProject, tabs],
  );
}

/** Opens (or focuses) editor/diff/PR-review/daemon-log tabs, deduped per worktree. */
function useTabOpeners(
  state: WorkspaceState,
  dispatch: WorkspaceDispatch,
): {
  openFileTab: (path: string, opts?: { paneId?: string }) => Promise<void>;
  openDiffTab: (
    path: string,
    side: DiffSide,
    opts?: { paneId?: string; commit?: string | null },
  ) => Promise<void>;
  openReviewTab: (prNumber: number, title: string) => Promise<void>;
  openDaemonLogTab: () => Promise<void>;
  openPluginWebView: (request: OpenPluginWebViewRequest) => Promise<void>;
  openScratchpadFile: (filePath: string, title: string) => Promise<void>;
} {
  const openDedupedTab = useOpenDedupedTab(state, dispatch);

  const openLocatorTab = useCallback(
    (
      kind: "editor" | "diff",
      path: string,
      side: DiffSide | null,
      paneId: string | undefined,
      commit?: string | null,
    ) =>
      openDedupedTab({
        paneId,
        match: (tab, { worktreeId }) =>
          tab.kind === kind &&
          tab.worktreeId === worktreeId &&
          tab.filePath === path &&
          tab.diffSide === side &&
          (tab.diffCommit ?? null) === (commit ?? null),
        create: ({ projectId, worktreeId }) =>
          createTabCommand(
            projectId,
            worktreeId,
            kind,
            basename(path),
            undefined,
            path,
            side,
            commit ?? null,
          ),
      }),
    [openDedupedTab],
  );

  const openFileTab = useCallback(
    (path: string, opts?: { paneId?: string }) =>
      openLocatorTab("editor", path, null, opts?.paneId),
    [openLocatorTab],
  );
  const openDiffTab = useCallback(
    (path: string, side: DiffSide, opts?: { paneId?: string; commit?: string | null }) =>
      openLocatorTab("diff", path, side, opts?.paneId, opts?.commit),
    [openLocatorTab],
  );

  const openPluginWebView = useCallback(
    (request: OpenPluginWebViewRequest) =>
      openDedupedTab({
        requireTargetError: "Cannot open plugin web view without an active worktree",
        rethrow: true,
        match: (tab, { worktreeId }) =>
          request.dedupeKey !== undefined &&
          tab.kind === "plugin-webview" &&
          tab.worktreeId === worktreeId &&
          tab.pluginId === request.pluginId &&
          tab.pluginViewId === request.pluginViewId &&
          tab.pluginDedupeKey === request.dedupeKey,
        create: ({ projectId, worktreeId }) =>
          createPluginWebViewTab({
            projectId,
            worktreeId,
            title: request.title,
            pluginId: request.pluginId,
            pluginViewId: request.pluginViewId,
            pluginPayload: request.payloadJson,
            pluginDedupeKey: request.dedupeKey,
          }),
      }),
    [openDedupedTab],
  );

  const openReviewTab = useCallback(
    (prNumber: number, title: string) =>
      openDedupedTab({
        match: (tab, { worktreeId }) =>
          tab.kind === "pr-review" && tab.worktreeId === worktreeId && tab.prNumber === prNumber,
        create: ({ projectId, worktreeId }) =>
          createTabCommand(
            projectId,
            worktreeId,
            "pr-review",
            title,
            undefined,
            null,
            null,
            null,
            prNumber,
          ),
      }),
    [openDedupedTab],
  );

  const openDaemonLogTab = useCallback(
    () =>
      openDedupedTab({
        match: (tab) => tab.kind === "log",
        create: ({ projectId, worktreeId }) =>
          createTabCommand(projectId, worktreeId, "log", defaultTabTitle("log")),
      }),
    [openDedupedTab],
  );

  const openScratchpadFile = useCallback(
    (filePath: string, title: string) =>
      openDedupedTab({
        match: (tab, { worktreeId }) =>
          tab.kind === "scratchpad" && tab.worktreeId === worktreeId && tab.filePath === filePath,
        create: ({ worktreeId }) => openScratchpadTabCommand(worktreeId, filePath, title),
      }),
    [openDedupedTab],
  );

  return {
    openFileTab,
    openDiffTab,
    openReviewTab,
    openDaemonLogTab,
    openPluginWebView,
    openScratchpadFile,
  };
}

/** Closes/renames/activates tabs and drops them from the managed-scripts set. */
function useTabLifecycle(
  state: WorkspaceState,
  dispatch: WorkspaceDispatch,
  setManagedScriptsState: Dispatch<SetStateAction<ManagedScriptsState>>,
): {
  closeTab: (tabId: string) => Promise<void>;
  renameTerminalTab: (tabId: string, title: string) => Promise<void>;
  markTabAgent: (tabId: string, agent: AgentConfig) => Promise<void>;
  setActiveTab: (tabId: string | null) => void;
  setActiveTabRef: RefObject<(tabId: string | null) => void>;
} {
  const closeTab = useCallback(
    async (tabId: string) => {
      terminalManager.dispose(tabId);
      removeAgentStatusForTab(tabId);
      releaseAlertLatchForTab(tabId);
      void browserClose(tabId);
      try {
        await closeTabCommand(tabId);
        dispatch({ type: "remove-tab", tabId });
        setManagedScriptsState((current) => {
          for (const [worktreeId, byName] of Object.entries(current)) {
            for (const [name, scripts] of Object.entries(byName)) {
              if (!scripts.tabIds.includes(tabId)) {
                continue;
              }
              const tabIds = scripts.tabIds.filter((id) => id !== tabId);
              if (tabIds.length > 0) {
                return {
                  ...current,
                  [worktreeId]: { ...byName, [name]: { ...scripts, tabIds } },
                };
              }
              const { [name]: _, ...remainingByName } = byName;
              if (Object.keys(remainingByName).length > 0) {
                return { ...current, [worktreeId]: remainingByName };
              }
              const { [worktreeId]: __, ...remaining } = current;
              return remaining;
            }
          }
          return current;
        });
      } catch (cause) {
        dispatch({ type: "load-error", error: errorMessage(cause) });
      }
    },
    [dispatch, setManagedScriptsState],
  );

  const renameTerminalTab = useCallback(
    async (tabId: string, title: string) => {
      try {
        await renameTabCommand(tabId, title);
        dispatch({ type: "rename-tab", tabId, title });
      } catch (cause) {
        dispatch({ type: "load-error", error: errorMessage(cause) });
      }
    },
    [dispatch],
  );

  // Marks a freshly created terminal tab as hosting a launched agent: the tab
  // takes the agent's icon and its title seeds with the agent's display name.
  const markTabAgent = useCallback(
    async (tabId: string, agent: AgentConfig) => {
      dispatch({ type: "set-tab-agent", tabId, agentId: agent.id, title: agent.name });
      try {
        await setTabAgentCommand(tabId, agent.id, agent.name);
      } catch (cause) {
        dispatch({ type: "load-error", error: errorMessage(cause) });
      }
    },
    [dispatch],
  );

  const setActiveTab = useCallback(
    (tabId: string | null) => {
      const worktreeId = tabId ? state.tabs.find((tab) => tab.id === tabId)?.worktreeId : undefined;
      if (!tabId || !worktreeId) {
        return;
      }
      clearDoneStatusForTab(tabId);
      dispatch({ type: "set-active-tab", worktreeId, tabId });
    },
    [dispatch, state.tabs],
  );
  const setActiveTabRef = useRef(setActiveTab);
  setActiveTabRef.current = setActiveTab;
  return { closeTab, renameTerminalTab, markTabAgent, setActiveTab, setActiveTabRef };
}

/** Keeps the in-memory workspace snapshot synced after brokered CLI mutations. */
function useWorkspaceChangedListener(
  tabs: readonly Tab[],
  dispatch: WorkspaceDispatch,
  refreshProject: (projectId?: string | null) => Promise<void>,
): void {
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const refreshProjectRef = useRef(refreshProject);
  refreshProjectRef.current = refreshProject;
  const handleChanged = useCallback(
    (payload: WorkspaceChangedEvent) => {
      const removedTabIds =
        payload.action === "tabClosed" && payload.tabId
          ? [payload.tabId]
          : payload.action === "worktreeDeleted" && payload.worktreeId
            ? tabsRef.current
                .filter((tab) => tab.worktreeId === payload.worktreeId)
                .map((tab) => tab.id)
            : [];
      for (const tabId of removedTabIds) {
        terminalManager.dispose(tabId);
        removeAgentStatusForTab(tabId);
        releaseAlertLatchForTab(tabId);
      }
      // `tabOpened` is for interactive CLI opens (select so the user sees it).
      // `tabOpenedBackground` is for mobile/Kanban-style agent launches: refresh
      // the snapshot only — selecting would mount a terminal and spawn an empty
      // shell that races the background agent `ptySpawn`.
      if (payload.action === "tabOpened" && payload.worktreeId && payload.tabId) {
        dispatch({
          type: "select-worktree",
          projectId: payload.projectId,
          worktreeId: payload.worktreeId,
        });
        dispatch({ type: "set-active-tab", worktreeId: payload.worktreeId, tabId: payload.tabId });
      }
      void refreshProjectRef.current(payload.projectId).catch(() => undefined);
    },
    [dispatch],
  );
  const handleChangedRef = useRef(handleChanged);
  handleChangedRef.current = handleChanged;
  useEffect(() => {
    let cancelled = false;
    let unlistenWorktrees: (() => void) | null = null;
    let unlistenTabs: (() => void) | null = null;
    void onWorktreeChanged((payload) => handleChangedRef.current(payload)).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return undefined;
      }
      unlistenWorktrees = unlisten;
      return undefined;
    });
    void onTabsChanged((payload) => handleChangedRef.current(payload)).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return undefined;
      }
      unlistenTabs = unlisten;
      return undefined;
    });
    return () => {
      cancelled = true;
      unlistenWorktrees?.();
      unlistenTabs?.();
    };
  }, []);
}

/** Mount-time + selection-driven project loading (reload, agents, details, icons). */
function useProjectLoading(
  state: WorkspaceState,
  dispatch: WorkspaceDispatch,
  reload: () => Promise<void>,
): void {
  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(listPluginAgents())
      .then((agents) => {
        if (!cancelled) {
          for (const agent of agents) {
            void refreshAgentModels(agent.id);
          }
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void onAgentSessionLaunch((request) => {
      const agent = listPluginAgents().find((candidate) => candidate.id === request.agentId);
      if (!agent) {
        toast.error(`Couldn't launch ${request.agentId}: agent is unavailable.`);
        return;
      }
      dispatch({
        type: "set-tab-agent",
        tabId: request.tabId,
        agentId: agent.id,
        title: agent.name,
      });
      void setTabAgentCommand(request.tabId, agent.id, agent.name).catch((cause) => {
        dispatch({ type: "load-error", error: errorMessage(cause) });
      });
      void startBackgroundAgentSession(
        request.tabId,
        request.worktreeId,
        request.worktreePath,
        agent,
        request.prompt ?? undefined,
        { modelId: request.modelId, reasoningId: request.reasoningId, modelCmd: request.modelCmd },
      ).catch((cause: unknown) => {
        console.warn(`failed to launch remote agent ${agent.id}`, cause);
        toast.error("Couldn't launch agent session from your phone.");
      });
    }).then((nextUnlisten) => {
      if (cancelled) {
        nextUnlisten();
      } else {
        unlisten = nextUnlisten;
      }
      return undefined;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [dispatch]);

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
          dispatch({ type: "set-splits", projectId, worktreeRoots: parseStoredSplits(splits) });
        }
      } catch (cause) {
        if (!cancelled) {
          dispatch({ type: "load-error", error: errorMessage(cause) });
        }
      }
    }
    void loadProjectDetails(state.selectedProjectId);
    return () => {
      cancelled = true;
    };
  }, [dispatch, state.selectedProjectId]);

  useEffect(() => {
    for (const project of state.projects) {
      if (project.id in state.icons) {
        continue;
      }
      void projectIcon(project.id).then((icon) =>
        dispatch({ type: "set-icon", projectId: project.id, icon }),
      );
    }
  }, [dispatch, state.icons, state.projects]);

  useEffect(() => {
    const unknownWorktreeIds = Object.values(state.worktrees)
      .flat()
      .map((worktree) => worktree.id)
      .filter((worktreeId) => !(worktreeId in state.remoteWorktrees));
    if (unknownWorktreeIds.length === 0) {
      return;
    }

    let cancelled = false;
    void worktreesAreRemote(unknownWorktreeIds)
      .then((remoteByWorktreeId) => {
        if (cancelled) {
          return undefined;
        }
        for (const worktreeId of unknownWorktreeIds) {
          dispatch({
            type: "set-worktree-remote",
            worktreeId,
            isRemote: remoteByWorktreeId[worktreeId] ?? false,
          });
        }
        return undefined;
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        for (const worktreeId of unknownWorktreeIds) {
          dispatch({ type: "set-worktree-remote", worktreeId, isRemote: false });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dispatch, state.remoteWorktrees, state.worktrees]);
}

/** Persists split layouts so they survive project switches and app restarts. */
function useSplitPersist(state: WorkspaceState): void {
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
}

/** Persists the active project + per-project last-active worktree selection. */
function useSelectionPersistence(
  state: WorkspaceState,
  didHydrateRef: RefObject<boolean>,
  lastPersistedRef: RefObject<string | null>,
): void {
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
      toast.error(`Failed to save active selection: ${errorMessage(cause)}`);
    });
  }, [didHydrateRef, lastPersistedRef, state.selectedProjectId, state.selectedWorktreeByProject]);
}

/** Records every resolved worktree selection through one centralized effect. */
function useWorktreeMruPersistence(state: WorkspaceState, didHydrateRef: RefObject<boolean>): void {
  const projectId = state.selectedProjectId;
  const worktreeId = projectId ? state.selectedWorktreeByProject[projectId] : null;
  useEffect(() => {
    if (!didHydrateRef.current || !worktreeId) return;
    void touchWorktreeMru(worktreeId).catch(() => undefined);
  }, [didHydrateRef, worktreeId]);
}

/** Latches seen attention/done statuses for a tab, clears its green dot, marks seen. */
function latchAndClearSeenTab(tabId: string): void {
  let hasDone = false;
  for (const entry of agentStatusesForTab(tabId)) {
    if (entry.status === "attention" || entry.status === "done") {
      latchAlertedStatus({
        worktreeId: entry.worktreeId,
        tabId,
        agent: entry.agent,
        status: entry.status,
      });
    }
    if (entry.status === "done") {
      hasDone = true;
    }
  }
  clearDoneStatusForTab(tabId);
  if (hasDone) {
    void markAgentsSeen(tabId);
  }
}

/** Marks on-screen tabs' agent statuses as seen so reconnect replays don't re-alert. */
function useVisibleTabAgentSeen(visibleTabIds: Set<string>): void {
  useEffect(() => {
    for (const tabId of visibleTabIds) {
      latchAndClearSeenTab(tabId);
    }
  }, [visibleTabIds]);
}

/** Interactive project scripts (`run`, `build`, and any custom names): start, stop, derived state. */
function useManagedScripts(
  state: WorkspaceState,
  dispatch: WorkspaceDispatch,
  closeTab: (tabId: string) => Promise<void>,
  managedScriptsState: ManagedScriptsState,
  setManagedScriptsState: Dispatch<SetStateAction<ManagedScriptsState>>,
  setRunScriptsConfig: (config: ProjectScriptsConfig | null) => void,
  setRunScriptsConfigError: (error: string | null) => void,
): {
  activeScripts: Array<{ name: string; stopping: boolean }>;
  runningScripts: RunningScript[];
  runScript: (name: string) => Promise<void>;
  stopScript: (name: string) => Promise<void>;
} {
  const selectedWorktreeId = state.selectedProjectId
    ? (state.selectedWorktreeByProject[state.selectedProjectId] ?? null)
    : null;
  const layoutStackRef = useRef<Record<string, string[]>>({});
  const activeScripts = useMemo(
    () => activeManagedScripts(managedScriptsState, selectedWorktreeId),
    [managedScriptsState, selectedWorktreeId],
  );
  const runningScripts = useMemo(
    () =>
      Object.values(managedScriptsState).flatMap((byName) =>
        Object.values(byName).flatMap((scripts) =>
          scripts.tabIds.map((tabId) => ({
            worktreeId: scripts.worktreeId,
            tabId,
            name: scripts.name,
            stopping: scripts.stopping,
          })),
        ),
      ),
    [managedScriptsState],
  );

  const runScript = useCallback(
    async (name: string) => {
      const projectId = state.selectedProjectId;
      const worktreeId = projectId ? state.selectedWorktreeByProject[projectId] : undefined;
      if (!projectId || !worktreeId || managedScriptsState[worktreeId]?.[name]) {
        return;
      }
      const cwd =
        state.worktrees[projectId]?.find((worktree) => worktree.id === worktreeId)?.path ?? "~";
      const ctx: ManagedScriptRunContext = {
        projectId,
        worktreeId,
        cwd,
        scriptName: name,
        dispatch,
        setManagedScriptsState,
        splitRootByWorktree: state.splitRootByWorktree,
        closeTab,
        layoutStackRef,
      };
      const startedTabIds: string[] = [];
      let splitSnapshot: RunScriptsSplitSnapshot | null = null;
      try {
        const config = await loadProjectScripts(projectId);
        setRunScriptsConfig(config);
        setRunScriptsConfigError(null);
        splitSnapshot = await runManagedScriptPlan(ctx, config, startedTabIds);
      } catch (cause) {
        await handleManagedScriptsFailure(ctx, splitSnapshot, startedTabIds, cause);
      }
    },
    [
      closeTab,
      dispatch,
      managedScriptsState,
      setManagedScriptsState,
      setRunScriptsConfig,
      setRunScriptsConfigError,
      state.selectedProjectId,
      state.selectedWorktreeByProject,
      state.splitRootByWorktree,
      state.worktrees,
    ],
  );

  const stopScript = useCallback(
    async (name: string) => {
      const worktreeId = state.selectedProjectId
        ? state.selectedWorktreeByProject[state.selectedProjectId]
        : undefined;
      const current = worktreeId ? managedScriptsState[worktreeId]?.[name] : undefined;
      if (!current) {
        return;
      }
      setManagedScriptsState((previous) => ({
        ...previous,
        [current.worktreeId]: {
          ...previous[current.worktreeId],
          [name]: { ...current, stopping: true },
        },
      }));
      if (current.splitSnapshot) {
        popScriptLayout(
          dispatch,
          setManagedScriptsState,
          layoutStackRef,
          current.worktreeId,
          name,
          current.splitSnapshot,
        );
      }
      await Promise.all(current.tabIds.map((tabId) => closeTab(tabId)));
      setManagedScriptsState((previous) => {
        const byName = previous[current.worktreeId];
        if (!byName) {
          return previous;
        }
        const { [name]: _, ...remainingByName } = byName;
        if (Object.keys(remainingByName).length > 0) {
          return { ...previous, [current.worktreeId]: remainingByName };
        }
        const { [current.worktreeId]: __, ...remaining } = previous;
        return remaining;
      });
    },
    [
      closeTab,
      dispatch,
      managedScriptsState,
      setManagedScriptsState,
      state.selectedProjectId,
      state.selectedWorktreeByProject,
    ],
  );

  return { activeScripts, runningScripts, runScript, stopScript };
}

/** Worktree open/status/delete/rename/hide actions. */
function useWorktreeActions(
  state: WorkspaceState,
  dispatch: WorkspaceDispatch,
  setManagedScriptsState: Dispatch<SetStateAction<ManagedScriptsState>>,
  selectedWorktree: Worktree | null,
): {
  openSelectedWorktree: (editorId?: string | null) => Promise<void>;
  openWorktreeInEditor: (worktreeId: string, editorId?: string | null) => Promise<void>;
  getWorktreeStatus: (worktreeId: string) => Promise<WorktreeStatus>;
  deleteWorktree: (
    worktreeId: string,
    options: { deleteBranch: boolean; force: boolean },
  ) => Promise<void>;
  renameWorktree: (worktreeId: string, title: string) => Promise<void>;
  hideWorktree: (worktreeId: string, hidden: boolean) => Promise<void>;
} {
  const openSelectedWorktree = useCallback(
    async (editorId?: string | null) => {
      if (!selectedWorktree) {
        return;
      }
      try {
        await openWorktreeCommand(selectedWorktree.id, editorId);
      } catch (cause) {
        dispatch({ type: "load-error", error: errorMessage(cause) });
      }
    },
    [dispatch, selectedWorktree],
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
        dispatch({ type: "load-error", error: errorMessage(cause) });
      }
    },
    [dispatch, state.worktrees],
  );

  const getWorktreeStatus = useCallback(async (worktreeId: string) => {
    return worktreeStatusCommand(worktreeId);
  }, []);

  const deleteWorktree = useCallback(
    async (worktreeId: string, options: { deleteBranch: boolean; force: boolean }) => {
      const removedTabs = state.tabs.filter((tab) => tab.worktreeId === worktreeId);
      await deleteWorktreeCommand(worktreeId, options.deleteBranch, options.force);
      for (const tab of removedTabs) {
        terminalManager.dispose(tab.id);
        removeAgentStatusForTab(tab.id);
        releaseAlertLatchForTab(tab.id);
        if (tab.kind === "browser") {
          void browserClose(tab.id);
        }
      }
      dispatch({ type: "remove-worktree", worktreeId });
      setManagedScriptsState((current) => {
        const { [worktreeId]: _, ...remaining } = current;
        return remaining;
      });
    },
    [dispatch, setManagedScriptsState, state.tabs],
  );

  const renameWorktree = useCallback(
    async (worktreeId: string, title: string) => {
      try {
        const updated = await renameWorktreeCommand(worktreeId, title);
        dispatch({ type: "update-worktree", worktree: updated });
      } catch (cause) {
        dispatch({ type: "load-error", error: errorMessage(cause) });
      }
    },
    [dispatch],
  );

  const hideWorktree = useCallback(
    async (worktreeId: string, hidden: boolean) => {
      try {
        const updated = await setWorktreeHiddenCommand(worktreeId, hidden);
        dispatch({ type: "update-worktree", worktree: updated });
      } catch (cause) {
        dispatch({ type: "load-error", error: errorMessage(cause) });
      }
    },
    [dispatch],
  );

  return {
    openSelectedWorktree,
    openWorktreeInEditor,
    getWorktreeStatus,
    deleteWorktree,
    renameWorktree,
    hideWorktree,
  };
}

/** Resolves the legacy (non-split) active tab id for the selected worktree. */
function selectLegacyActiveTab(
  state: WorkspaceState,
  selectedWorktreeId: string,
  visibleTabs: Tab[],
): string | null {
  const remembered = state.activeTabByWorktree[selectedWorktreeId];
  if (remembered && visibleTabs.some((tab) => tab.id === remembered)) {
    return remembered;
  }
  return visibleTabs[0]?.id ?? null;
}

/** Resolves the effective split root from the stored root + legacy active tab. */
function resolveSplitRoot(
  storedSplitRoot: SplitLayoutNode | null,
  legacyActiveTabId: string | null,
  activeTabInStoredSplit: SplitPaneNode | null,
  selectedWorktreeId: string,
  tabs: Tab[],
): SplitLayoutNode | null {
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
  return storedSplitRoot ?? initialRootForWorktree(selectedWorktreeId, tabs, legacyActiveTabId);
}

/** Focused pane for a root, scoped to the selected worktree's stored focus id. */
function focusedPaneForRoot(
  root: SplitLayoutNode | null,
  focusedPaneByWorktree: Record<string, string>,
  selectedWorktreeId: string | null,
): SplitPaneNode | null {
  return focusForRoot(root, selectedWorktreeId ? focusedPaneByWorktree[selectedWorktreeId] : null);
}

/** Pane id when a real split is shown, else null. */
function focusedPaneIdForSplit(
  splitRoot: SplitLayoutNode | null,
  focusedPane: SplitPaneNode | null,
): string | null {
  if (splitRoot?.kind !== "split") {
    return null;
  }
  return focusedPane?.id ?? null;
}

/** Pane's active tab id when a real split is shown, else null. */
function representativeTabIdForSplit(
  splitRoot: SplitLayoutNode | null,
  focusedPane: SplitPaneNode | null,
): string | null {
  if (splitRoot?.kind !== "split") {
    return null;
  }
  return focusedPane?.activeTabId ?? null;
}

/** Derives the split layout + active tab for the selected worktree. */
function useSplitLayout(
  state: WorkspaceState,
  selectedWorktreeId: string | null,
): {
  visibleTabs: Tab[];
  legacyActiveTabId: string | null;
  storedSplitRoot: SplitLayoutNode | null;
  splitRoot: SplitLayoutNode | null;
  focusedPaneId: string | null;
  activeTabId: string | null;
  activeTab: Tab | null;
  splitRepresentativeTabId: string | null;
} {
  const visibleTabs = useMemo(
    () => state.tabs.filter((tab) => tab.worktreeId === selectedWorktreeId),
    [state.tabs, selectedWorktreeId],
  );
  const legacyActiveTabId = useMemo(
    () =>
      selectedWorktreeId ? selectLegacyActiveTab(state, selectedWorktreeId, visibleTabs) : null,
    [selectedWorktreeId, state, visibleTabs],
  );
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
  const storedFocusedPane = focusedPaneForRoot(
    storedSplitRoot,
    state.focusedPaneByWorktree,
    selectedWorktreeId,
  );
  const splitRepresentativeTabId = representativeTabIdForSplit(storedSplitRoot, storedFocusedPane);
  const splitRoot = useMemo(
    () =>
      selectedWorktreeId
        ? resolveSplitRoot(
            storedSplitRoot,
            legacyActiveTabId,
            activeTabInStoredSplit,
            selectedWorktreeId,
            state.tabs,
          )
        : null,
    [activeTabInStoredSplit, legacyActiveTabId, selectedWorktreeId, state.tabs, storedSplitRoot],
  );
  const focusedPane = focusedPaneForRoot(
    splitRoot,
    state.focusedPaneByWorktree,
    selectedWorktreeId,
  );
  const focusedPaneId = focusedPaneIdForSplit(splitRoot, focusedPane);
  const activeTabId = legacyActiveTabId;
  const activeTab = visibleTabs.find((tab) => tab.id === activeTabId) ?? null;
  return {
    visibleTabs,
    legacyActiveTabId,
    storedSplitRoot,
    splitRoot,
    focusedPaneId,
    activeTabId,
    activeTab,
    splitRepresentativeTabId,
  };
}

/** Computes the tab-id cycle order for the pane (or top-bar fallback) the active tab is in. */
function computeCyclePaneTabIds(
  visibleTabs: Tab[],
  storedSplitRoot: SplitLayoutNode | null,
  activeTabId: string,
  splitRepresentativeTabId: string | null,
): { paneTabIds: string[]; activeStoredPane: SplitPaneNode | null } {
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
  return { paneTabIds, activeStoredPane };
}

/** Split-pane focus/active/split/move actions + top-bar/pane tab cycling. */
function useSplitActions(
  dispatch: WorkspaceDispatch,
  selectedWorktreeId: string | null,
  splitRoot: SplitLayoutNode | null,
  focusedPaneId: string | null,
  visibleTabs: Tab[],
  activeTabId: string | null,
  storedSplitRoot: SplitLayoutNode | null,
  splitRepresentativeTabId: string | null,
): {
  focusPane: (paneId: string) => void;
  setPaneActiveTab: (paneId: string, tabId: string) => void;
  splitTabAtPane: (
    tabId: string,
    paneId: string,
    direction: SplitDirection,
    placement: SplitPlacement,
  ) => void;
  splitActivePane: (tabId: string, direction: SplitDirection) => void;
  moveTabToPane: (tabId: string, paneId: string) => void;
  cycleTab: (direction: 1 | -1) => void;
} {
  const focusPane = useCallback(
    (paneId: string) => {
      if (!selectedWorktreeId) {
        return;
      }
      const pane = paneById(splitRoot, paneId);
      if (pane?.activeTabId) {
        clearDoneStatusForTab(pane.activeTabId);
      }
      dispatch({ type: "focus-pane", worktreeId: selectedWorktreeId, paneId });
    },
    [dispatch, selectedWorktreeId, splitRoot],
  );

  const setPaneActiveTab = useCallback(
    (paneId: string, tabId: string) => {
      if (!selectedWorktreeId) {
        return;
      }
      clearDoneStatusForTab(tabId);
      dispatch({ type: "set-pane-active-tab", worktreeId: selectedWorktreeId, paneId, tabId });
    },
    [dispatch, selectedWorktreeId],
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
    [dispatch, selectedWorktreeId],
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
    [dispatch, focusedPaneId, selectedWorktreeId],
  );

  const moveTabToPane = useCallback(
    (tabId: string, paneId: string) => {
      if (!selectedWorktreeId) {
        return;
      }
      dispatch({ type: "move-tab-to-pane", worktreeId: selectedWorktreeId, paneId, tabId });
    },
    [dispatch, selectedWorktreeId],
  );

  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      if (visibleTabs.length === 0 || !activeTabId || !selectedWorktreeId) {
        return;
      }
      const { paneTabIds, activeStoredPane } = computeCyclePaneTabIds(
        visibleTabs,
        storedSplitRoot,
        activeTabId,
        splitRepresentativeTabId,
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
      if (visibleTabs.find((tab) => tab.id === tabId)?.kind === "terminal") {
        terminalManager.focus(tabId, true);
      }
    },
    [
      activeTabId,
      dispatch,
      selectedWorktreeId,
      splitRepresentativeTabId,
      storedSplitRoot,
      visibleTabs,
    ],
  );

  return {
    focusPane,
    setPaneActiveTab,
    splitTabAtPane,
    splitActivePane,
    moveTabToPane,
    cycleTab,
  };
}

/** Derives the active project + selected worktree for the current selection. */
function deriveSelectedWorktree(state: WorkspaceState): {
  activeProject: Project | null;
  projectWorktrees: Worktree[];
  selectedWorktreeId: string | null;
  selectedWorktree: Worktree | null;
} {
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
  return { activeProject, projectWorktrees, selectedWorktreeId, selectedWorktree };
}

/** Agent navigation, worktree resolution, and agent-status event listeners. */
function useAgentManagement({
  stateRef,
  worktreeProjectIdRef,
  dispatch,
  visibleTabIdsRef,
}: {
  stateRef: RefObject<WorkspaceState>;
  worktreeProjectIdRef: RefObject<Record<string, string>>;
  dispatch: WorkspaceDispatch;
  visibleTabIdsRef: RefObject<Set<string>>;
}) {
  const {
    agentBackLocation,
    setAgentBackLocation,
    activateLocation,
    navigateToAgentLocation,
    goBackFromAgent,
  } = useAgentNavigation(stateRef, dispatch);
  const { resolveProjectForWorktree, describeAgentLocation, isTabCurrentlyViewed } =
    useWorktreeResolution(stateRef, worktreeProjectIdRef, dispatch);
  // Renames the hosting tab to the agent-reported session name. User renames
  // win; the persisted title update leaves `userRenamed` untouched.
  const applySessionName = useCallback(
    (payload: AgentReportPayload) => {
      const name = payload.sessionName?.trim();
      if (!name) {
        return;
      }
      const tab = stateRef.current.tabs.find((candidate) => candidate.id === payload.tabId);
      if (!tab || tab.userRenamed || tab.title === name) {
        return;
      }
      dispatch({ type: "set-session-title", tabId: payload.tabId, title: name });
      void setTabTitleCommand(payload.tabId, name).catch(() => undefined);
    },
    [dispatch, stateRef],
  );
  useAgentStatusListeners({
    visibleTabIdsRef,
    applySessionName,
    clearDoneStatusForTab,
    markAgentsSeen,
    latchAlertedStatus,
    releaseAlertLatch,
    isTabCurrentlyViewed,
    shouldAlertForStatus,
    resolveProjectForWorktree,
    describeAgentLocation,
    navigateToAgentLocation,
    alertAgent,
  });
  return {
    agentBackLocation,
    setAgentBackLocation,
    activateLocation,
    navigateToAgentLocation,
    goBackFromAgent,
    resolveProjectForWorktree,
  };
}

/** Tab creation, launching, deep-link, terminal-link, openers, lifecycle, and id key. */
function useTabManagement({
  state,
  dispatch,
  stateRef,
  worktreeProjectIdRef,
  selectedProjectIdRef,
  tabsRef,
  selectWorktree,
  selectProject,
  resolveProjectForWorktree,
  setManagedScriptsState,
}: {
  state: WorkspaceState;
  dispatch: WorkspaceDispatch;
  stateRef: RefObject<WorkspaceState>;
  worktreeProjectIdRef: RefObject<Record<string, string>>;
  selectedProjectIdRef: RefObject<string | null>;
  tabsRef: RefObject<Tab[]>;
  selectWorktree: (worktreeId: string | null, projectId?: string) => void;
  selectProject: (projectId: string | null) => Promise<void>;
  resolveProjectForWorktree: (worktreeId: string) => Promise<string | null>;
  setManagedScriptsState: Dispatch<SetStateAction<ManagedScriptsState>>;
}) {
  const { createTerminalTab, createBrowserTab, createTabInPane } = useTabCreation(
    state,
    dispatch,
    worktreeProjectIdRef,
    selectedProjectIdRef,
  );
  const { closeTab, renameTerminalTab, markTabAgent, setActiveTab, setActiveTabRef } =
    useTabLifecycle(state, dispatch, setManagedScriptsState);
  const startSession = useSessionLaunch(selectWorktree, createTerminalTab, markTabAgent);
  useDeepLinkHandler(
    stateRef,
    resolveProjectForWorktree,
    selectProject,
    selectWorktree,
    startSession,
  );
  const openFromTerminalLink = useTerminalLinkOpener(
    dispatch,
    worktreeProjectIdRef,
    selectedProjectIdRef,
    tabsRef,
  );
  useTerminalLinkHandler(openFromTerminalLink);
  const {
    openFileTab,
    openDiffTab,
    openReviewTab,
    openDaemonLogTab,
    openPluginWebView,
    openScratchpadFile,
  } = useTabOpeners(state, dispatch);
  const terminalTabIdsKey = useMemo(
    () =>
      state.tabs
        .filter((tab) => tab.kind === "terminal")
        .map((tab) => tab.id)
        .join(TERMINAL_TAB_ID_SEPARATOR),
    [state.tabs],
  );
  return {
    createTerminalTab,
    createBrowserTab,
    createTabInPane,
    startSession,
    openFileTab,
    openDiffTab,
    openReviewTab,
    openDaemonLogTab,
    openPluginWebView,
    openScratchpadFile,
    closeTab,
    renameTerminalTab,
    markTabAgent,
    setActiveTab,
    setActiveTabRef,
    terminalTabIdsKey,
  };
}

/** Project loading plus browser and terminal metadata listeners. */
// fallow-ignore-next-line code-duplication -- param-destructuring shape shared with unrelated hooks (usePaletteAsyncData, usePrSubmit); not extractable logic.
function useWorkspaceListeners({
  state,
  dispatch,
  reload,
  tabsRef,
  terminalTabIdsKey,
  setActiveTabRef,
  refreshProject,
}: {
  state: WorkspaceState;
  dispatch: WorkspaceDispatch;
  reload: () => Promise<void>;
  refreshProject: (projectId?: string | null) => Promise<void>;
  tabsRef: RefObject<Tab[]>;
  terminalTabIdsKey: string;
  setActiveTabRef: RefObject<(tabId: string | null) => void>;
}): void {
  useProjectLoading(state, dispatch, reload);
  useWorkspaceChangedListener(state.tabs, dispatch, refreshProject);
  useTabMetaListeners(dispatch, tabsRef, terminalTabIdsKey, setActiveTabRef);
}

/** Split-layout + selection persistence. */
function useWorkspacePersistence(
  state: WorkspaceState,
  didHydrateRef: RefObject<boolean>,
  lastPersistedRef: RefObject<string | null>,
): void {
  useSplitPersist(state);
  useSelectionPersistence(state, didHydrateRef, lastPersistedRef);
  useWorktreeMruPersistence(state, didHydrateRef);
}

/** Worktree actions, split layout, managed scripts, visible tabs, and split actions. */
function useWorkspaceActions({
  state,
  dispatch,
  closeTab,
  managedScriptsState,
  setManagedScriptsState,
  setRunScriptsConfig,
  setRunScriptsConfigError,
  runScriptsConfig,
  selectedWorktree,
  selectedWorktreeId,
  visibleTabIdsRef,
}: {
  state: WorkspaceState;
  dispatch: WorkspaceDispatch;
  closeTab: (tabId: string) => Promise<void>;
  managedScriptsState: ManagedScriptsState;
  setManagedScriptsState: Dispatch<SetStateAction<ManagedScriptsState>>;
  setRunScriptsConfig: (config: ProjectScriptsConfig | null) => void;
  setRunScriptsConfigError: (error: string | null) => void;
  runScriptsConfig: ProjectScriptsConfig | null;
  selectedWorktree: Worktree | null;
  selectedWorktreeId: string | null;
  visibleTabIdsRef: RefObject<Set<string>>;
}) {
  const {
    openSelectedWorktree,
    openWorktreeInEditor,
    getWorktreeStatus,
    deleteWorktree,
    renameWorktree,
    hideWorktree,
  } = useWorktreeActions(state, dispatch, setManagedScriptsState, selectedWorktree);

  const {
    visibleTabs,
    storedSplitRoot,
    splitRoot,
    focusedPaneId,
    activeTabId,
    activeTab,
    splitRepresentativeTabId,
  } = useSplitLayout(state, selectedWorktreeId);

  // `run`/`build` are always reserved header buttons even when unconfigured;
  // any other `runScripts` key renders its own custom button, alphabetically.
  const scriptButtons: ScriptButtonInfo[] = useMemo(() => {
    const configured = runScriptsConfig?.runScripts ?? {};
    const names = new Set(["run", "build", ...Object.keys(configured)]);
    const order = (name: string) => (name === "run" ? 0 : name === "build" ? 1 : 2);
    return [...names]
      .map((name) => ({
        name,
        icon: configured[name]?.icon ?? null,
        available: (configured[name]?.command.length ?? 0) > 0,
      }))
      .toSorted((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
  }, [runScriptsConfig]);

  const { activeScripts, runningScripts, runScript, stopScript } = useManagedScripts(
    state,
    dispatch,
    closeTab,
    managedScriptsState,
    setManagedScriptsState,
    setRunScriptsConfig,
    setRunScriptsConfigError,
  );

  const visibleTabIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeTabId) {
      ids.add(activeTabId);
    }
    if (splitRoot?.kind === "split") {
      for (const tabId of activeTabIdsInNode(splitRoot)) {
        ids.add(tabId);
      }
    }
    return ids;
  }, [activeTabId, splitRoot]);
  visibleTabIdsRef.current = visibleTabIds;

  useVisibleTabAgentSeen(visibleTabIds);

  const { focusPane, setPaneActiveTab, splitTabAtPane, splitActivePane, moveTabToPane, cycleTab } =
    useSplitActions(
      dispatch,
      selectedWorktreeId,
      splitRoot,
      focusedPaneId,
      visibleTabs,
      activeTabId,
      storedSplitRoot,
      splitRepresentativeTabId,
    );

  return useMemo(
    () => ({
      openSelectedWorktree,
      openWorktreeInEditor,
      getWorktreeStatus,
      deleteWorktree,
      renameWorktree,
      hideWorktree,
      visibleTabs,
      splitRoot,
      focusedPaneId,
      activeTabId,
      activeTab,
      scriptButtons,
      activeScripts,
      runningScripts,
      runScript,
      stopScript,
      focusPane,
      setPaneActiveTab,
      splitTabAtPane,
      splitActivePane,
      moveTabToPane,
      cycleTab,
    }),
    [
      openSelectedWorktree,
      openWorktreeInEditor,
      getWorktreeStatus,
      deleteWorktree,
      renameWorktree,
      hideWorktree,
      visibleTabs,
      splitRoot,
      focusedPaneId,
      activeTabId,
      activeTab,
      scriptButtons,
      activeScripts,
      runningScripts,
      runScript,
      stopScript,
      focusPane,
      setPaneActiveTab,
      splitTabAtPane,
      splitActivePane,
      moveTabToPane,
      cycleTab,
    ],
  );
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, initialState);
  const [managedScriptsState, setManagedScriptsState] = useState<ManagedScriptsState>({});
  const mainWorktreeId = useMemo(() => {
    const worktrees = state.selectedProjectId
      ? state.worktrees[state.selectedProjectId]
      : undefined;
    return worktrees?.find((worktree) => worktree.isMain)?.id ?? null;
  }, [state.selectedProjectId, state.worktrees]);
  const { runScriptsConfig, runScriptsConfigError, setRunScriptsConfig, setRunScriptsConfigError } =
    useProjectScriptsConfig(state.selectedProjectId, mainWorktreeId);
  const {
    stateRef,
    tabsRef,
    selectedProjectIdRef,
    worktreeProjectIdRef,
    didHydrateRef,
    lastPersistedRef,
  } = useWorkspaceRefs(state);

  const visibleTabIdsRef = useRef<Set<string>>(new Set());

  const {
    agentBackLocation,
    setAgentBackLocation,
    activateLocation,
    navigateToAgentLocation,
    goBackFromAgent,
    resolveProjectForWorktree,
  } = useAgentManagement({ stateRef, worktreeProjectIdRef, dispatch, visibleTabIdsRef });

  const activateTabLocation = useCallback(
    (projectId: string, worktreeId: string, tabId: string) =>
      activateLocation(projectId, worktreeId, tabId, false),
    [activateLocation],
  );

  const openFileLocation = useCallback(
    async (input: {
      projectId: string;
      worktreeId: string;
      path: string;
      line?: number;
      column?: number;
    }) => {
      const projectTabs =
        stateRef.current.selectedProjectId === input.projectId
          ? stateRef.current.tabs
          : await loadProjectWorkspace(input.projectId, dispatch);
      let tab = projectTabs.find(
        (candidate) =>
          candidate.kind === "editor" &&
          candidate.worktreeId === input.worktreeId &&
          candidate.filePath === input.path,
      );
      if (!tab) {
        tab = await createTabCommand(
          input.projectId,
          input.worktreeId,
          "editor",
          basename(input.path),
          undefined,
          input.path,
          null,
        );
        dispatch({ type: "add-tab", tab });
      }
      if (input.line) requestEditorLocation(tab.id, input.line, input.column ?? 1);
      dispatch({
        type: "select-worktree",
        projectId: input.projectId,
        worktreeId: input.worktreeId,
      });
      dispatch({ type: "set-active-tab", worktreeId: input.worktreeId, tabId: tab.id });
    },
    [stateRef],
  );

  const { reload, selectProject, refreshProject, selectWorktree } = useProjectSelection(
    state,
    dispatch,
    { didHydrateRef, lastPersistedRef, selectedProjectIdRef, worktreeProjectIdRef },
    setAgentBackLocation,
  );

  const {
    createTerminalTab,
    createBrowserTab,
    startSession,
    createTabInPane,
    openFileTab,
    openDiffTab,
    openReviewTab,
    openDaemonLogTab,
    openPluginWebView,
    openScratchpadFile,
    closeTab,
    renameTerminalTab,
    markTabAgent,
    setActiveTab,
    setActiveTabRef,
    terminalTabIdsKey,
  } = useTabManagement({
    state,
    dispatch,
    stateRef,
    worktreeProjectIdRef,
    selectedProjectIdRef,
    tabsRef,
    selectWorktree,
    selectProject,
    resolveProjectForWorktree,
    setManagedScriptsState,
  });

  useWorkspaceListeners({
    state,
    dispatch,
    reload,
    refreshProject,
    tabsRef,
    terminalTabIdsKey,
    setActiveTabRef,
  });

  useWorkspacePersistence(state, didHydrateRef, lastPersistedRef);

  const { activeProject, selectedWorktreeId, selectedWorktree } = deriveSelectedWorktree(state);

  const workspaceActions = useWorkspaceActions({
    state,
    dispatch,
    closeTab,
    managedScriptsState,
    setManagedScriptsState,
    setRunScriptsConfig,
    setRunScriptsConfigError,
    runScriptsConfig,
    selectedWorktree,
    selectedWorktreeId,
    visibleTabIdsRef,
  });

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      ...state,
      ...workspaceActions,
      tabs: workspaceActions.visibleTabs,
      projectTabs: state.tabs,
      selectedWorktreeId,
      activeProject,
      selectedWorktree,
      reload,
      refreshProject,
      selectProject,
      selectWorktree,
      createTerminalTab,
      createBrowserTab,
      startSession,
      createTabInPane,
      openFileTab,
      openDiffTab,
      openReviewTab,
      openDaemonLogTab,
      openPluginWebView,
      openScratchpadFile,
      closeTab,
      renameTerminalTab,
      markTabAgent,
      setActiveTab,
      activateTabLocation,
      openFileLocation,
      runScriptsConfigError,
      agentBackAvailable: !!agentBackLocation && agentBackLocation.expiresAt >= Date.now(),
      navigateToAgentLocation,
      goBackFromAgent,
    }),
    [
      state,
      workspaceActions,
      selectedWorktreeId,
      activeProject,
      selectedWorktree,
      reload,
      refreshProject,
      selectProject,
      selectWorktree,
      createTerminalTab,
      createBrowserTab,
      startSession,
      createTabInPane,
      openFileTab,
      openDiffTab,
      openReviewTab,
      openDaemonLogTab,
      openPluginWebView,
      openScratchpadFile,
      closeTab,
      renameTerminalTab,
      markTabAgent,
      setActiveTab,
      activateTabLocation,
      openFileLocation,
      runScriptsConfigError,
      agentBackLocation,
      navigateToAgentLocation,
      goBackFromAgent,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** Accesses workspace metadata state and high-level actions. */
export function useWorkspace(): WorkspaceContextValue {
  return useRequiredContext(WorkspaceContext, "useWorkspace");
}
