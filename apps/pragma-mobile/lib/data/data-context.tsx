import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { statusForTabs } from "../agent-status";
import type { AgentStatus, AgentTab, InboxItem, Project, Worktree } from "../types";
import { buildWorktreeTree, type WorktreeNode } from "../worktree-tree";
import { MOCK_AGENT_TABS, MOCK_INBOX, MOCK_PROJECTS, MOCK_WORKTREES } from "./fixtures";

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
  /** Resolve and remove an inbox item. Server wiring replaces the body later. */
  resolveInboxItem: (id: string, resolution: InboxResolution) => void;
}

const DataContext = createContext<DataContextValue | null>(null);

/**
 * The swappable data layer. Today it seeds from mock fixtures and keeps state
 * locally; wiring the app server later means replacing the initial state and
 * `resolveInboxItem` body without touching any screen.
 */
export function DataProvider({ children }: { children: ReactNode }) {
  const [projects] = useState<Project[]>(MOCK_PROJECTS);
  const [worktrees] = useState<Worktree[]>(MOCK_WORKTREES);
  const [agentTabs] = useState<Record<string, AgentTab[]>>(MOCK_AGENT_TABS);
  const [inbox, setInbox] = useState<InboxItem[]>(MOCK_INBOX);

  const resolveInboxItem = useCallback((id: string, _resolution: InboxResolution) => {
    // Front-end only: taking an action just dismisses the card.
    setInbox((items) => items.filter((item) => item.id !== id));
  }, []);

  const value = useMemo<DataContextValue>(
    () => ({ projects, worktrees, agentTabs, inbox, resolveInboxItem }),
    [projects, worktrees, agentTabs, inbox, resolveInboxItem],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
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
  return useMemo(() => projects.toSorted((a, b) => a.orderIndex - b.orderIndex), [projects]);
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
  return useMemo(() => {
    const projectId = worktrees.find((w) => w.id === worktreeId)?.projectId;
    if (!projectId) return [];
    const tree = buildWorktreeTree(worktrees.filter((w) => w.projectId === projectId));
    return findNode(tree, worktreeId)?.children ?? [];
  }, [worktrees, worktreeId]);
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
