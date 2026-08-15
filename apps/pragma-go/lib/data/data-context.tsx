import type { AgentReportPayload, Tab } from "@pragma/constants";
import { PragmaGatewayError } from "@pragma/sdk";
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
import type { AgentStatus, AgentTab, InboxItem, Project, Worktree } from "../types";
import { buildWorktreeTree, type WorktreeNode } from "../worktree-tree";
import { MOCK_AGENT_TABS, MOCK_INBOX, MOCK_PROJECTS, MOCK_WORKTREES } from "./fixtures";
import {
  agentTabsBySnapshot,
  inboxFromStatuses,
  markTabStatusesSeen,
  parseAgentStatuses,
} from "./workspace-map";

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** A connection that lived this long counts as healthy: reset the backoff. */
const RECONNECT_HEALTHY_MS = 30_000;

/** How the user resolved an inbox item. */
export type InboxResolution =
  | { kind: "approve" }
  | { kind: "deny" }
  | { kind: "answer"; option: string };

interface DataContextValue {
  projects: Project[];
  worktrees: Worktree[];
  agentTabs: Record<string, AgentTab[]>;
  inbox: InboxItem[];
  /** Resolve and remove an inbox item; publishes the verdict when paired. */
  resolveInboxItem: (id: string, resolution: InboxResolution) => void;
  /** Clear a completed agent's unread status after its response is viewed. */
  markAgentSeen: (tabId: string) => void;
  /** End an agent's PTY and remove it from mobile navigation. */
  clearAgent: (tabId: string) => Promise<void>;
  /** Rename an agent's workspace tab. */
  renameAgent: (tabId: string, title: string) => Promise<void>;
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
  const {
    dismissed,
    hiddenTabIds,
    renamedTitles,
    setDismissed,
    setHiddenTabIds,
    setRenamedTitles,
  } = useAgentPresentation(client);
  const visibleStatuses = useMemo(
    () => statuses.filter((status) => !hiddenTabIds.has(status.tabId)),
    [hiddenTabIds, statuses],
  );

  const projects = useMemo<Project[]>(
    () => (paired ? (snapshot?.projects ?? []) : MOCK_PROJECTS),
    [paired, snapshot],
  );
  const worktrees = useMemo<Worktree[]>(
    () => (paired ? (snapshot?.worktrees ?? []) : MOCK_WORKTREES),
    [paired, snapshot],
  );

  const agentTabs = useMemo<Record<string, AgentTab[]>>(() => {
    const tabs = paired
      ? agentTabsBySnapshot(snapshot?.tabs ?? [], visibleStatuses)
      : MOCK_AGENT_TABS;
    return Object.fromEntries(
      Object.entries(tabs).map(([worktreeId, entries]) => [
        worktreeId,
        entries
          .filter((entry) => !hiddenTabIds.has(entry.id))
          .map((entry) => ({ ...entry, title: renamedTitles[entry.id] ?? entry.title })),
      ]),
    );
  }, [hiddenTabIds, paired, renamedTitles, snapshot, visibleStatuses]);

  const derivedInbox = useMemo<InboxItem[]>(
    () =>
      paired
        ? inboxFromStatuses(visibleStatuses, projects, worktrees, snapshot?.tabs ?? [])
        : MOCK_INBOX,
    [paired, visibleStatuses, projects, worktrees, snapshot],
  );

  const inbox = useMemo(
    () => derivedInbox.filter((item) => !dismissed.has(item.id)),
    [derivedInbox, dismissed],
  );

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
        if (error instanceof PragmaGatewayError && error.httpStatus === 401) handleUnauthorized();
      });
    },
    [client, handleUnauthorized, paired, setStatuses],
  );

  const clearAgent = useCallback(
    async (tabId: string) => {
      await runSessionAction(client, paired, handleUnauthorized, (activeClient) =>
        activeClient.sessions.kill(tabId),
      );
      setHiddenTabIds((previous) => new Set(previous).add(tabId));
    },
    [client, handleUnauthorized, paired, setHiddenTabIds],
  );

  const renameAgent = useCallback(
    async (tabId: string, title: string) => {
      await runSessionAction(client, paired, handleUnauthorized, (activeClient) =>
        activeClient.sessions.rename(tabId, title),
      );
      setRenamedTitles((previous) => ({ ...previous, [tabId]: title }));
    },
    [client, handleUnauthorized, paired, setRenamedTitles],
  );

  const value = useMemo<DataContextValue>(
    () => ({
      projects,
      worktrees,
      agentTabs,
      inbox,
      resolveInboxItem,
      markAgentSeen,
      clearAgent,
      renameAgent,
    }),
    [
      projects,
      worktrees,
      agentTabs,
      inbox,
      resolveInboxItem,
      markAgentSeen,
      clearAgent,
      renameAgent,
    ],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
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

function isUnauthorized(error: unknown): boolean {
  return error instanceof PragmaGatewayError && error.httpStatus === 401;
}

function reportUnauthorized(error: unknown, onUnauthorized: () => void): void {
  if (isUnauthorized(error)) onUnauthorized();
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

/** Retries `body` with exponential backoff until the signal aborts. */
async function subscriptionLoop(
  signal: AbortSignal,
  onUnauthorized: () => void,
  body: (onDelivered: () => void) => Promise<void>,
): Promise<void> {
  let backoff = RECONNECT_INITIAL_MS;
  while (!signal.aborted) {
    const result = await runSubscription(body);
    if (result === "unauthorized") {
      onUnauthorized();
      return;
    }
    if (signal.aborted) return;
    backoff = reconnectDelay(backoff, result);
    // oxlint-disable-next-line no-await-in-loop -- backoff between reconnects.
    await delay(backoff, signal);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }
}

async function runSubscription(
  body: (onDelivered: () => void) => Promise<void>,
): Promise<{ startedAt: number; delivered: boolean } | "unauthorized"> {
  const startedAt = Date.now();
  let delivered = false;
  try {
    // oxlint-disable-next-line no-await-in-loop -- sequential reconnect attempts.
    await body(() => {
      delivered = true;
    });
  } catch (error) {
    if (isUnauthorized(error)) return "unauthorized";
  }
  return { startedAt, delivered };
}

function reconnectDelay(
  backoff: number,
  result: { startedAt: number; delivered: boolean },
): number {
  // Streams routinely die after tunnel idle. A connection that delivered data —
  // or simply lived a long time — is healthy, so reconnect promptly instead of
  // carrying a large backoff across its lifetime.
  if (result.delivered || Date.now() - result.startedAt >= RECONNECT_HEALTHY_MS) {
    return RECONNECT_INITIAL_MS;
  }
  return backoff;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, ms));
  const aborted = new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  return Promise.race([timeout, aborted]);
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
  "markAgentSeen" | "clearAgent" | "renameAgent"
> {
  const { markAgentSeen, clearAgent, renameAgent } = useData();
  return { markAgentSeen, clearAgent, renameAgent };
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
