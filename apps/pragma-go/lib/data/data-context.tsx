import type { AgentReportPayload, Tab } from "@pragma-sh/constants";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { statusForTabs } from "../agent-status";
import { useConnection } from "../connection-context";
import { reportUnauthorized } from "../report-unauthorized";
import type { AgentStatus, AgentTab, InboxItem, Project, TerminalTab, Worktree } from "../types";
import { buildWorktreeTree, type WorktreeNode } from "../worktree-tree";
import { MOCK_AGENT_TABS, MOCK_INBOX, MOCK_PROJECTS, MOCK_WORKTREES } from "./fixtures";
import {
  agentTabsBySnapshot,
  terminalTabsBySnapshot,
  inboxFromStatuses,
  markTabStatusesSeen,
  parseAgentStatuses,
} from "./workspace-map";
import { subscriptionLoop } from "./subscription-loop";

/** How the user resolved an inbox item. */
export type InboxResolution =
  | { kind: "approve" }
  | { kind: "deny" }
  | { kind: "answer"; option: string };

interface DataContextValue {
  projects: Project[];
  worktrees: Worktree[];
  agentTabs: Record<string, AgentTab[]>;
  /** Ordinary terminals (shells, script runs) per worktree; never agent sessions. */
  terminalTabs: Record<string, TerminalTab[]>;
  inbox: InboxItem[];
  /** Resolve and remove an inbox item; publishes the verdict when paired. */
  resolveInboxItem: (id: string, resolution: InboxResolution) => void;
  /** Clear a completed agent's unread status after its response is viewed. */
  markAgentSeen: (tabId: string) => void;
  /** End an agent's PTY and remove it from mobile navigation. */
  clearAgent: (tabId: string) => Promise<void>;
  /** Rename a workspace tab — an agent session or an ordinary terminal. */
  renameTab: (tabId: string, title: string) => Promise<void>;
  /** Open a host-owned terminal in a worktree and return its tab id. */
  openTerminal: (worktreeId: string) => Promise<string>;
  /** Close a terminal tab and end its process, on every device showing it. */
  closeTerminal: (tabId: string) => Promise<void>;
}

const DataContext = createContext<DataContextValue | null>(null);

interface LiveSnapshot {
  projects: Project[];
  worktrees: Worktree[];
  tabs: Tab[];
}

/**
 * The swappable data layer. When a desktop is paired it subscribes to the host's
 * workspace snapshot + agent statuses and derives the view models; unpaired (or
 * in dev without env), it falls back to the mock fixtures so every screen still
 * renders. Screens never change — only the source behind this provider does.
 */
export function DataProvider({ children }: { children: ReactNode }) {
  const { client, status: connectionStatus, handleUnauthorized } = useConnection();
  const paired = connectionStatus === "paired" && !!client;
  const { snapshot, statuses, setStatuses } = useSubscriptionData(client, handleUnauthorized);
  const presentation = useAgentPresentation(client);
  const view = useWorkspaceView(paired, snapshot, statuses, presentation);
  const actions = useTabActions(client, paired, handleUnauthorized, presentation);

  const { setDismissed } = presentation;
  const { derivedInbox } = view;
  const resolveInboxItem = useCallback(
    (id: string, resolution: InboxResolution) => {
      setDismissed((prev) => new Set(prev).add(id));
      void publishInboxResolution(client, paired, derivedInbox, id, resolution).catch(
        () => undefined,
      );
    },
    [paired, client, derivedInbox, setDismissed],
  );

  const markAgentSeen = useCallback(
    (tabId: string) => {
      setStatuses((previous) => markTabStatusesSeen(previous, tabId));
      if (!paired || !client) return;
      void client.agents.markAgentsSeen({ tabId }).catch((error: unknown) => {
        reportUnauthorized(error, handleUnauthorized);
      });
    },
    [client, handleUnauthorized, paired, setStatuses],
  );

  const { projects, worktrees, agentTabs, terminalTabs, inbox } = view;
  const { clearAgent, renameTab, openTerminal, closeTerminal } = actions;
  const value = useMemo<DataContextValue>(
    () => ({
      projects,
      worktrees,
      agentTabs,
      terminalTabs,
      inbox,
      resolveInboxItem,
      markAgentSeen,
      clearAgent,
      renameTab,
      openTerminal,
      closeTerminal,
    }),
    [
      projects,
      worktrees,
      agentTabs,
      terminalTabs,
      inbox,
      resolveInboxItem,
      markAgentSeen,
      clearAgent,
      renameTab,
      openTerminal,
      closeTerminal,
    ],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

type Presentation = ReturnType<typeof useAgentPresentation>;

/**
 * The view models every screen reads: the live snapshot when paired, the
 * fixtures otherwise, with locally hidden and renamed tabs applied on top.
 */
function useWorkspaceView(
  paired: boolean,
  snapshot: LiveSnapshot | null,
  statuses: AgentReportPayload[],
  { dismissed, hiddenTabIds, renamedTitles }: Presentation,
) {
  const visibleStatuses = useMemo(
    () => statuses.filter((status) => !hiddenTabIds.has(status.tabId)),
    [hiddenTabIds, statuses],
  );
  const tabs = snapshot?.tabs;

  const projects = useMemo<Project[]>(
    () => (paired ? (snapshot?.projects ?? []) : MOCK_PROJECTS),
    [paired, snapshot],
  );
  const worktrees = useMemo<Worktree[]>(
    () => (paired ? (snapshot?.worktrees ?? []) : MOCK_WORKTREES),
    [paired, snapshot],
  );

  const agentTabs = useMemo<Record<string, AgentTab[]>>(
    () =>
      presentTabs(
        paired ? agentTabsBySnapshot(tabs ?? [], visibleStatuses) : MOCK_AGENT_TABS,
        hiddenTabIds,
        renamedTitles,
      ),
    [hiddenTabIds, paired, renamedTitles, tabs, visibleStatuses],
  );

  // Unpaired, the fixtures carry agent sessions only: an invented shell would
  // imply a terminal the demo cannot attach to.
  const terminalTabs = useMemo<Record<string, TerminalTab[]>>(
    () =>
      presentTabs(
        paired ? terminalTabsBySnapshot(tabs ?? [], statuses) : {},
        hiddenTabIds,
        renamedTitles,
      ),
    [hiddenTabIds, paired, renamedTitles, tabs, statuses],
  );

  const derivedInbox = useMemo<InboxItem[]>(
    () =>
      paired ? inboxFromStatuses(visibleStatuses, projects, worktrees, tabs ?? []) : MOCK_INBOX,
    [paired, visibleStatuses, projects, worktrees, tabs],
  );

  const inbox = useMemo(
    () => derivedInbox.filter((item) => !dismissed.has(item.id)),
    [derivedInbox, dismissed],
  );

  return { projects, worktrees, agentTabs, terminalTabs, derivedInbox, inbox };
}

/** Drops locally hidden tabs and applies local renames, per worktree. */
function presentTabs<T extends { id: string; title: string }>(
  byWorktree: Record<string, T[]>,
  hiddenTabIds: ReadonlySet<string>,
  renamedTitles: Record<string, string>,
): Record<string, T[]> {
  return Object.fromEntries(
    Object.entries(byWorktree).map(([worktreeId, entries]) => [
      worktreeId,
      entries
        .filter((entry) => !hiddenTabIds.has(entry.id))
        .map((entry) => ({ ...entry, title: renamedTitles[entry.id] ?? entry.title })),
    ]),
  );
}

/** Tab mutations: each acts on the host when paired and updates the local view. */
function useTabActions(
  client: Client | null,
  paired: boolean,
  handleUnauthorized: () => void,
  { setHiddenTabIds, setRenamedTitles }: Presentation,
) {
  const clearAgent = useCallback(
    async (tabId: string) => {
      await runSessionAction(client, paired, handleUnauthorized, (activeClient) =>
        activeClient.sessions.kill(tabId),
      );
      setHiddenTabIds((previous) => withId(previous, tabId));
    },
    [client, handleUnauthorized, paired, setHiddenTabIds],
  );

  const renameTab = useCallback(
    async (tabId: string, title: string) => {
      await runSessionAction(client, paired, handleUnauthorized, (activeClient) =>
        activeClient.sessions.rename(tabId, title),
      );
      setRenamedTitles((previous) => ({ ...previous, [tabId]: title }));
    },
    [client, handleUnauthorized, paired, setRenamedTitles],
  );

  const openTerminal = useCallback(
    async (worktreeId: string) => {
      if (!paired || !client) throw new Error("Not connected to a host");
      // A fresh request id per tap, so a retry inside this call is idempotent
      // while a deliberate second tap still opens a second terminal.
      const tab = await client.tabs.openTerminal({
        worktreeId,
        requestId: `${worktreeId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      });
      return tab.id;
    },
    [client, paired],
  );

  const closeTerminal = useCallback(
    async (tabId: string) => {
      // Hide it locally first: the snapshot that drops the row arrives a beat
      // later, and a row that lingers after an explicit close looks broken.
      setHiddenTabIds((previous) => withId(previous, tabId));
      try {
        await runSessionAction(client, paired, handleUnauthorized, (activeClient) =>
          activeClient.tabs.close(tabId),
        );
      } catch (error: unknown) {
        setHiddenTabIds((previous) => withoutId(previous, tabId));
        throw error;
      }
    },
    [client, handleUnauthorized, paired, setHiddenTabIds],
  );

  return { clearAgent, renameTab, openTerminal, closeTerminal };
}

function withId(ids: ReadonlySet<string>, id: string): Set<string> {
  return new Set(ids).add(id);
}

function withoutId(ids: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(ids);
  next.delete(id);
  return next;
}

type Client = NonNullable<ReturnType<typeof useConnection>["client"]>;

function useSubscriptionData(client: Client | null, onUnauthorized: () => void) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [statuses, setStatuses] = useState<AgentReportPayload[]>([]);

  useEffect(() => {
    if (!client) {
      setSnapshot(null);
      setStatuses([]);
      return undefined;
    }
    const controller = new AbortController();
    runWorkspaceSubscription(client, controller.signal, setSnapshot, onUnauthorized);
    runAgentStatusSubscription(client, controller.signal, setStatuses, onUnauthorized);
    return () => controller.abort();
  }, [client, onUnauthorized]);

  return { snapshot, statuses, setStatuses };
}

function useAgentPresentation(client: Client | null) {
  const [renamedTitles, setRenamedTitles] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [hiddenTabIds, setHiddenTabIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setDismissed(new Set());
    setHiddenTabIds(new Set());
    setRenamedTitles({});
  }, [client]);

  return {
    dismissed,
    hiddenTabIds,
    renamedTitles,
    setDismissed,
    setHiddenTabIds,
    setRenamedTitles,
  };
}

async function publishInboxResolution(
  client: Client | null,
  paired: boolean,
  inbox: InboxItem[],
  id: string,
  resolution: InboxResolution,
): Promise<void> {
  const activeClient = pairedClient(client, paired);
  const item = inboxRequest(inbox, id);
  if (!activeClient || !item) return;
  await reportInboxResolution(activeClient, item, resolution);
}

function pairedClient(client: Client | null, paired: boolean): Client | null {
  return paired ? client : null;
}

function inboxRequest(inbox: InboxItem[], id: string): InboxRequest | undefined {
  const item = inbox.find((entry) => entry.id === id);
  return isInboxRequest(item) ? item : undefined;
}

type InboxRequest = InboxItem & { tabId: string; requestId: string };

function isInboxRequest(item: InboxItem | undefined): item is InboxRequest {
  return Boolean(item?.tabId && item.requestId);
}

async function reportInboxResolution(
  client: Client,
  item: InboxRequest,
  resolution: InboxResolution,
): Promise<void> {
  const request = {
    agent: item.agent,
    worktreeId: item.worktreeId,
    tabId: item.tabId,
    requestId: item.requestId,
  };
  if (item.kind === "command") {
    await reportCommandResolution(client, request, resolution);
    return;
  }
  await reportQuestionResolution(client, request, resolution);
}

async function reportCommandResolution(
  client: Client,
  request: Pick<InboxRequest, "agent" | "worktreeId" | "tabId" | "requestId">,
  resolution: InboxResolution,
): Promise<void> {
  await client.agents.reportDecision({ ...request, approved: resolution.kind === "approve" });
}

async function reportQuestionResolution(
  client: Client,
  request: Pick<InboxRequest, "agent" | "worktreeId" | "tabId" | "requestId">,
  resolution: InboxResolution,
): Promise<void> {
  if (resolution.kind !== "answer") {
    await client.agents.reportAnswer({ ...request, dismissed: true });
    return;
  }
  await client.agents.reportAnswer({ ...request, dismissed: false, answer: resolution.option });
}

async function runSessionAction(
  client: Client | null,
  paired: boolean,
  onUnauthorized: () => void,
  action: (client: Client) => Promise<void>,
): Promise<void> {
  const activeClient = pairedClient(client, paired);
  if (!activeClient) return;
  try {
    await action(activeClient);
  } catch (error) {
    reportUnauthorized(error, onUnauthorized);
    throw error;
  }
}

/** Runs the workspace snapshot subscription with capped-backoff reconnect. */
function runWorkspaceSubscription(
  client: Client,
  signal: AbortSignal,
  onSnapshot: (snapshot: LiveSnapshot) => void,
  onUnauthorized: () => void,
): void {
  void subscriptionLoop(signal, onUnauthorized, async (onDelivered) => {
    for await (const event of client.workspace.subscribe({ signal })) {
      onDelivered();
      onSnapshot({
        projects: event.payload.projects,
        worktrees: event.payload.worktrees,
        tabs: event.payload.tabs,
      });
    }
  });
}

/** Runs the agent-status subscription with capped-backoff reconnect. */
function runAgentStatusSubscription(
  client: Client,
  signal: AbortSignal,
  onStatuses: (statuses: AgentReportPayload[]) => void,
  onUnauthorized: () => void,
): void {
  void subscriptionLoop(signal, onUnauthorized, async (onDelivered) => {
    for await (const event of client.events.subscribe("agentStatus", { signal })) {
      onDelivered();
      onStatuses(parseAgentStatuses(event.payload));
    }
  });
}

function useData(): DataContextValue {
  const value = useContext(DataContext);
  if (!value) {
    throw new Error("useData must be used within a DataProvider");
  }
  return value;
}

/** All projects, ordered as the desktop sidebar orders them. */
export function useProjects(): Project[] {
  const { projects } = useData();
  return useMemo(() => {
    // Hermes does not yet provide Array.prototype.toSorted.
    // oxlint-disable-next-line unicorn/no-array-sort
    return [...projects].sort((a, b) => a.orderIndex - b.orderIndex);
  }, [projects]);
}

/** Every worktree across all projects, unordered. */
export function useWorktrees(): Worktree[] {
  const { worktrees } = useData();
  return worktrees;
}

/** Agent tabs for every worktree, keyed by worktree id. */
export function useAllAgentTabs(): Record<string, AgentTab[]> {
  const { agentTabs } = useData();
  return agentTabs;
}

/** A single project by id (or undefined). */
export function useProject(projectId: string): Project | undefined {
  const { projects } = useData();
  return useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);
}

/** A single worktree by id (or undefined). */
export function useWorktree(worktreeId: string): Worktree | undefined {
  const { worktrees } = useData();
  return useMemo(() => worktrees.find((w) => w.id === worktreeId), [worktrees, worktreeId]);
}

/**
 * The host path of a project's main worktree — the root every project-scoped
 * `.pragma` file (theme, keybindings, config) hangs off, on whichever host
 * owns the project. Undefined while the workspace is still loading.
 */
export function useProjectRootPath(projectId: string | undefined): string | undefined {
  const { worktrees } = useData();
  return useMemo(
    () => worktrees.find((w) => w.projectId === projectId && w.isMain)?.path,
    [worktrees, projectId],
  );
}

/** The nested worktree tree (roots) for a project. */
export function useWorktreeTree(projectId: string): WorktreeNode[] {
  const { worktrees } = useData();
  return useMemo(
    () => buildWorktreeTree(worktrees.filter((w) => w.projectId === projectId)),
    [worktrees, projectId],
  );
}

/** Direct child worktrees of a given worktree (one nesting level). */
export function useChildWorktrees(worktreeId: string): WorktreeNode[] {
  const { worktrees } = useData();
  return useMemo(() => childWorktreesOf(worktrees, worktreeId), [worktrees, worktreeId]);
}

/** The direct children of `worktreeId` within its own project's tree. */
function childWorktreesOf(worktrees: Worktree[], worktreeId: string): WorktreeNode[] {
  const worktree = worktrees.find((w) => w.id === worktreeId);
  if (!worktree) return [];
  const siblings = worktrees.filter((w) => w.projectId === worktree.projectId);
  return findNode(buildWorktreeTree(siblings), worktreeId)?.children ?? [];
}

/** Agent tabs hosted by a worktree. */
export function useAgentTabs(worktreeId: string): AgentTab[] {
  const { agentTabs } = useData();
  return agentTabs[worktreeId] ?? [];
}

/** A single agent tab by id, across all worktrees. */
export function useAgentTab(tabId: string): AgentTab | undefined {
  const { agentTabs } = useData();
  return useMemo(() => {
    for (const tabs of Object.values(agentTabs)) {
      const found = tabs.find((tab) => tab.id === tabId);
      if (found) return found;
    }
    return undefined;
  }, [agentTabs, tabId]);
}

/** Actions affecting one agent session. */
export function useAgentActions(): Pick<
  DataContextValue,
  "markAgentSeen" | "clearAgent" | "renameTab"
> {
  const { markAgentSeen, clearAgent, renameTab } = useData();
  return { markAgentSeen, clearAgent, renameTab };
}

/** Aggregate agent status for a worktree AND everything nested beneath it. */
export function useWorktreeStatus(worktreeId: string): AgentStatus | null {
  const { worktrees, agentTabs } = useData();
  return useMemo(() => {
    const projectId = worktrees.find((w) => w.id === worktreeId)?.projectId;
    if (!projectId) return null;
    const tree = buildWorktreeTree(worktrees.filter((w) => w.projectId === projectId));
    const node = findNode(tree, worktreeId);
    return node ? subtreeStatus(node, agentTabs) : null;
  }, [worktrees, agentTabs, worktreeId]);
}

/** Aggregate agent status across an entire project. */
export function useProjectStatus(projectId: string): AgentStatus | null {
  const { worktrees, agentTabs } = useData();
  return useMemo(() => {
    const roots = buildWorktreeTree(worktrees.filter((w) => w.projectId === projectId));
    return statusForTabs(roots.flatMap((node) => collectTabs(node, agentTabs)));
  }, [worktrees, agentTabs, projectId]);
}

/** The inbox items plus the resolve action. */
export function useInbox(): { items: InboxItem[]; resolve: DataContextValue["resolveInboxItem"] } {
  const { inbox, resolveInboxItem } = useData();
  return { items: inbox, resolve: resolveInboxItem };
}

function findNode(nodes: WorktreeNode[], worktreeId: string): WorktreeNode | undefined {
  for (const node of nodes) {
    if (node.worktree.id === worktreeId) return node;
    const nested = findNode(node.children, worktreeId);
    if (nested) return nested;
  }
  return undefined;
}

function collectTabs(node: WorktreeNode, agentTabs: Record<string, AgentTab[]>): AgentTab[] {
  return [
    ...(agentTabs[node.worktree.id] ?? []),
    ...node.children.flatMap((child) => collectTabs(child, agentTabs)),
  ];
}

function subtreeStatus(
  node: WorktreeNode,
  agentTabs: Record<string, AgentTab[]>,
): AgentStatus | null {
  return statusForTabs(collectTabs(node, agentTabs));
}

/** Ordinary terminals (shells, script runs) hosted by a worktree. */
export function useTerminalTabs(worktreeId: string): TerminalTab[] {
  const { terminalTabs } = useData();
  return terminalTabs[worktreeId] ?? [];
}

/** A single terminal tab by id, across all worktrees. */
export function useTerminalTab(tabId: string): TerminalTab | undefined {
  const { terminalTabs } = useData();
  return useMemo(() => {
    for (const tabs of Object.values(terminalTabs)) {
      const found = tabs.find((tab) => tab.id === tabId);
      if (found) return found;
    }
    return undefined;
  }, [terminalTabs, tabId]);
}

/** Actions on a worktree's ordinary terminals. */
export function useTerminalActions(): Pick<
  DataContextValue,
  "openTerminal" | "closeTerminal" | "renameTab"
> {
  const { openTerminal, closeTerminal, renameTab } = useData();
  return { openTerminal, closeTerminal, renameTab };
}
