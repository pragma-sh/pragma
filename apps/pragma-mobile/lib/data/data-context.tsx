import type { AgentReportPayload, Tab } from "@pragma/constants";
import { PragmaGatewayError } from "@pragma/sdk";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
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

  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [statuses, setStatuses] = useState<AgentReportPayload[]>([]);
  const [liveTitles, setLiveTitles] = useState<Record<string, string>>({});
  const [renamedTitles, setRenamedTitles] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [hiddenTabIds, setHiddenTabIds] = useState<Set<string>>(() => new Set());
  const visibleStatuses = useMemo(
    () => statuses.filter((status) => !hiddenTabIds.has(status.tabId)),
    [hiddenTabIds, statuses],
  );
  const agentTabIdsKey = useMemo(
    // Hermes does not yet provide Array.prototype.toSorted.
    // oxlint-disable-next-line unicorn/no-array-sort
    () => [...new Set(visibleStatuses.map((status) => status.tabId))].sort().join("\u0000"),
    [visibleStatuses],
  );

  // Subscribe to the host workspace + agent statuses while paired.
  useEffect(() => {
    if (!client) {
      setSnapshot(null);
      setStatuses([]);
      return undefined;
    }
    const controller = new AbortController();
    runWorkspaceSubscription(client, controller.signal, setSnapshot, handleUnauthorized);
    runAgentStatusSubscription(client, controller.signal, setStatuses, handleUnauthorized);
    return () => controller.abort();
  }, [client, handleUnauthorized]);

  useEffect(() => {
    setDismissed(new Set());
    setHiddenTabIds(new Set());
    setRenamedTitles({});
  }, [client]);

  // Workspace snapshots only change after desktop persists a title. Listen to
  // the PTYs directly so coding-agent OSC title changes reach mobile immediately.
  useEffect(() => {
    if (!client || !agentTabIdsKey) {
      setLiveTitles({});
      return undefined;
    }
    const controller = new AbortController();
    const tabIds = agentTabIdsKey.split("\u0000");
    const activeTabIds = new Set(tabIds);
    setLiveTitles((previous) => {
      const next = Object.fromEntries(
        Object.entries(previous).filter(([tabId]) => activeTabIds.has(tabId)),
      );
      return Object.keys(next).length === Object.keys(previous).length ? previous : next;
    });
    for (const tabId of tabIds) {
      runSessionTitleSubscription(
        client,
        tabId,
        controller.signal,
        setLiveTitles,
        handleUnauthorized,
      );
    }
    return () => controller.abort();
  }, [agentTabIdsKey, client, handleUnauthorized]);

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
      ? agentTabsBySnapshot(snapshot?.tabs ?? [], visibleStatuses, liveTitles)
      : MOCK_AGENT_TABS;
    return Object.fromEntries(
      Object.entries(tabs).map(([worktreeId, entries]) => [
        worktreeId,
        entries
          .filter((entry) => !hiddenTabIds.has(entry.id))
          .map((entry) => ({ ...entry, title: renamedTitles[entry.id] ?? entry.title })),
      ]),
    );
  }, [hiddenTabIds, paired, renamedTitles, snapshot, visibleStatuses, liveTitles]);

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
      if (!paired || !client) return;
      const item = derivedInbox.find((entry) => entry.id === id);
      if (!item?.requestId || !item.tabId) return;
      const base = {
        agent: item.agent,
        worktreeId: item.worktreeId,
        tabId: item.tabId,
        requestId: item.requestId,
      };
      if (item.kind === "command") {
        void client.agents
          .reportDecision({ ...base, approved: resolution.kind === "approve" })
          .catch(() => undefined);
      } else {
        const answered = resolution.kind === "answer";
        void client.agents
          .reportAnswer({
            ...base,
            dismissed: !answered,
            ...(answered ? { answer: resolution.option } : {}),
          })
          .catch(() => undefined);
      }
    },
    [paired, client, derivedInbox],
  );

  const markAgentSeen = useCallback(
    (tabId: string) => {
      setStatuses((previous) => markTabStatusesSeen(previous, tabId));
      if (!paired || !client) return;
      void client.agents.markAgentsSeen({ tabId }).catch((error: unknown) => {
        if (error instanceof PragmaGatewayError && error.httpStatus === 401) handleUnauthorized();
      });
    },
    [client, handleUnauthorized, paired],
  );

  const clearAgent = useCallback(
    async (tabId: string) => {
      if (paired && client) {
        try {
          await client.sessions.kill(tabId);
        } catch (error) {
          if (error instanceof PragmaGatewayError && error.httpStatus === 401) handleUnauthorized();
          throw error;
        }
      }
      setHiddenTabIds((previous) => new Set(previous).add(tabId));
    },
    [client, handleUnauthorized, paired],
  );

  const renameAgent = useCallback(
    async (tabId: string, title: string) => {
      if (paired && client) {
        try {
          await client.sessions.rename(tabId, title);
        } catch (error) {
          if (error instanceof PragmaGatewayError && error.httpStatus === 401) handleUnauthorized();
          throw error;
        }
      }
      setRenamedTitles((previous) => ({ ...previous, [tabId]: title }));
    },
    [client, handleUnauthorized, paired],
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

/** Runs the workspace snapshot subscription with capped-backoff reconnect. */
function runWorkspaceSubscription(
  client: Client,
  signal: AbortSignal,
  onSnapshot: (snapshot: LiveSnapshot) => void,
  onUnauthorized: () => void,
): void {
  void subscriptionLoop(signal, onUnauthorized, async () => {
    for await (const event of client.workspace.subscribe({ signal })) {
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
  void subscriptionLoop(signal, onUnauthorized, async () => {
    for await (const event of client.events.subscribe("agentStatus", { signal })) {
      onStatuses(parseAgentStatuses(event.payload));
    }
  });
}

/** Streams OSC title events for one agent session and ignores terminal output. */
function runSessionTitleSubscription(
  client: Client,
  tabId: string,
  signal: AbortSignal,
  onTitle: Dispatch<SetStateAction<Record<string, string>>>,
  onUnauthorized: () => void,
): void {
  void subscriptionLoop(signal, onUnauthorized, async () => {
    for await (const event of client.sessions.attach(tabId, { signal })) {
      if (event.type !== "title") continue;
      onTitle((previous) =>
        previous[tabId] === event.title ? previous : { ...previous, [tabId]: event.title },
      );
    }
  });
}

/** Retries `body` with exponential backoff until the signal aborts. */
async function subscriptionLoop(
  signal: AbortSignal,
  onUnauthorized: () => void,
  body: () => Promise<void>,
): Promise<void> {
  let backoff = RECONNECT_INITIAL_MS;
  while (!signal.aborted) {
    const startedAt = Date.now();
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential reconnect attempts.
      await body();
    } catch (error) {
      if (error instanceof PragmaGatewayError && error.httpStatus === 401) {
        onUnauthorized();
        return;
      }
    }
    if (signal.aborted) return;
    // Streams routinely die after minutes of tunnel idle; a connection that
    // held for a while was healthy, so reconnect promptly instead of letting
    // the backoff creep toward the cap across the session's lifetime.
    if (Date.now() - startedAt >= RECONNECT_HEALTHY_MS) {
      backoff = RECONNECT_INITIAL_MS;
    }
    // oxlint-disable-next-line no-await-in-loop -- backoff between reconnects.
    await delay(backoff, signal);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const wake = (): void => resolve();
    const timer = setTimeout(wake, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        wake();
      },
      { once: true },
    );
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
