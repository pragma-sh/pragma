import { statusForTabs, statusRank } from "../agent-status";
import type {
  AgentAttentionKind,
  AgentStatus,
  AgentTab,
  InboxItem,
  Project,
  Worktree,
} from "../types";
import { buildWorktreeTree, worktreeLabel, type WorktreeNode } from "../worktree-tree";

/**
 * SwiftUI named colors, used instead of the app's hex tokens because a widget
 * has no NativeWind theme and the system colors already adapt to the home
 * screen's light/dark and tinted rendering modes.
 */
export type WidgetStatusColor = "red" | "orange" | "green" | "gray";

/** How many inbox rows the large inbox widget can show before it clips. */
export const WIDGET_INBOX_LIMIT = 4;
/** How many project rows the large project widget can show before it clips. */
export const WIDGET_PROJECT_LIMIT = 5;
/** How many worktree rows the project widget carries across all its projects. */
export const WIDGET_WORKTREE_LIMIT = 8;
/** Prompts are truncated in the app so the widget never carries a whole command. */
const WIDGET_PROMPT_LIMIT = 90;

/**
 * The three buckets shown by the agent-status widget. Every tracked agent falls
 * into exactly one, so the three add up to `total`.
 */
export interface WidgetAgentCounts {
  /** Agents producing output and not blocked (`running`) — the amber status. */
  working: number;
  /** Agents blocked on an approval or a question — the red status. */
  attention: number;
  /** Agents that are idle: finished, cleared, or open without a live report. */
  done: number;
  /** Sum of the three buckets. */
  total: number;
}

/** One pending request, flattened for the inbox widget. */
export interface WidgetInboxEntry {
  id: string;
  kind: AgentAttentionKind;
  /** SF Symbol name matching `kind`. */
  symbol: string;
  agent: string;
  /** `project / worktree` context line. */
  location: string;
  prompt: string;
  /** Deep link opening the inbox. */
  url: string;
}

/**
 * One worktree row beneath a project, mirroring the app's worktree tree. Only
 * worktrees that are active or carry an unviewed result appear (plus the
 * ancestors that hold them, so the nesting still reads as the app's tree).
 */
export interface WidgetWorktreeEntry {
  id: string;
  /** Display label — `main` for the main worktree, else its title/branch. */
  name: string;
  color: WidgetStatusColor;
  /** Nesting depth in the project's worktree tree; 0 for a root. */
  depth: number;
  /** Agents hosted directly by this worktree, excluding its children. */
  agents: number;
  /** Deep link opening the worktree. */
  url: string;
}

/** One project row, rolled up for the project widget. */
export interface WidgetProjectEntry {
  id: string;
  name: string;
  color: WidgetStatusColor;
  /** Agents currently tracked in the project. */
  agents: number;
  /** Deep link opening the project. */
  url: string;
  /** The project's active/unviewed worktrees, in the app's tree order. */
  worktrees: WidgetWorktreeEntry[];
}

/** Everything the app pushes to the widget extension on each refresh. */
export interface WidgetSnapshot {
  paired: boolean;
  /** When the app last derived this snapshot, epoch milliseconds. */
  updatedAt: number;
  counts: WidgetAgentCounts;
  /** The first `WIDGET_INBOX_LIMIT` pending requests. */
  inbox: WidgetInboxEntry[];
  /** How many requests are pending in total, including the ones not carried. */
  inboxTotal: number;
  projects: WidgetProjectEntry[];
  /** Deep link opening the inbox — the default target for every widget. */
  inboxUrl: string;
}

/** Deep links the app resolves for the widget, which cannot build its own. */
export interface WidgetLinks {
  inbox: string;
  project: (projectId: string) => string;
  worktree: (worktreeId: string) => string;
}

interface WidgetSnapshotInput {
  paired: boolean;
  projects: Project[];
  worktrees: Worktree[];
  agentTabs: Record<string, AgentTab[]>;
  inbox: InboxItem[];
  links: WidgetLinks;
  now: number;
}

/** The empty snapshot, used before pairing and when the host has no agents. */
export function emptyWidgetSnapshot(links: WidgetLinks, now: number): WidgetSnapshot {
  return {
    paired: false,
    updatedAt: now,
    counts: { working: 0, attention: 0, done: 0, total: 0 },
    inbox: [],
    inboxTotal: 0,
    projects: [],
    inboxUrl: links.inbox,
  };
}

/** Derives the widget payload from the same view models the screens render. */
export function buildWidgetSnapshot(input: WidgetSnapshotInput): WidgetSnapshot {
  if (!input.paired) return emptyWidgetSnapshot(input.links, input.now);
  const tabs = Object.values(input.agentTabs).flat();
  return {
    paired: true,
    updatedAt: input.now,
    counts: countAgents(tabs),
    inbox: input.inbox.slice(0, WIDGET_INBOX_LIMIT).map((item) => inboxEntry(item, input.links)),
    inboxTotal: input.inbox.length,
    projects: projectEntries(input),
    inboxUrl: input.links.inbox,
  };
}

/** Buckets every agent tab into the three widget counters. */
function countAgents(tabs: AgentTab[]): WidgetAgentCounts {
  const counts = { working: 0, attention: 0, done: 0, total: tabs.length };
  for (const tab of tabs) {
    if (tab.status === "running") counts.working += 1;
    else if (tab.status === "attention") counts.attention += 1;
    // `done`, `cleared`, and a tab with no live report all read as idle.
    else counts.done += 1;
  }
  return counts;
}

function inboxEntry(item: InboxItem, links: WidgetLinks): WidgetInboxEntry {
  return {
    id: item.id,
    kind: item.kind,
    symbol: item.kind === "command" ? "terminal.fill" : "questionmark.circle.fill",
    agent: item.agent,
    location: `${item.projectName} / ${item.worktreeLabel}`,
    prompt: truncate(item.prompt || item.detail || "", WIDGET_PROMPT_LIMIT),
    url: links.inbox,
  };
}

/**
 * The project rows, each carrying the worktrees worth surfacing: one that has a
 * live agent (`running`/`attention`) or a finished result the user has not
 * viewed yet (`done`). A `cleared` agent — viewed, or never reporting — is not
 * news, so its worktree is left out.
 */
function projectEntries(input: WidgetSnapshotInput): WidgetProjectEntry[] {
  const entries: WidgetProjectEntry[] = [];
  let remainingWorktrees = WIDGET_WORKTREE_LIMIT;
  for (const project of input.projects) {
    if (entries.length >= WIDGET_PROJECT_LIMIT || remainingWorktrees <= 0) break;
    const roots = buildWorktreeTree(input.worktrees.filter((w) => w.projectId === project.id));
    const worktrees = worktreeRows(roots, input.agentTabs, input.links).slice(
      0,
      remainingWorktrees,
    );
    if (worktrees.length === 0) continue;
    remainingWorktrees -= worktrees.length;
    entries.push(projectEntry(project, roots, worktrees, input.agentTabs, input.links));
  }
  return entries;
}

function projectEntry(
  project: Project,
  roots: WorktreeNode[],
  worktrees: WidgetWorktreeEntry[],
  agentTabs: Record<string, AgentTab[]>,
  links: WidgetLinks,
): WidgetProjectEntry {
  const tabs = roots.flatMap((node) => liveTabsInSubtree(node, agentTabs));
  return {
    id: project.id,
    name: project.name,
    color: statusColor(statusForTabs(tabs)),
    agents: tabs.length,
    url: links.project(project.id),
    worktrees,
  };
}

/**
 * Flattens the project's worktree tree into widget rows, depth-first in the same
 * order the app lists them. A node is kept when anything in its subtree is live,
 * so an idle parent still appears above a busy child rather than orphaning it.
 */
function worktreeRows(
  nodes: WorktreeNode[],
  agentTabs: Record<string, AgentTab[]>,
  links: WidgetLinks,
  depth = 0,
): WidgetWorktreeEntry[] {
  const rows: WidgetWorktreeEntry[] = [];
  for (const node of nodes) {
    const subtree = liveTabsInSubtree(node, agentTabs);
    if (subtree.length === 0) continue;
    rows.push({
      id: node.worktree.id,
      name: worktreeLabel(node.worktree),
      color: statusColor(statusForTabs(subtree)),
      depth,
      agents: liveTabs(agentTabs[node.worktree.id] ?? []).length,
      url: links.worktree(node.worktree.id),
    });
    rows.push(...worktreeRows(node.children, agentTabs, links, depth + 1));
  }
  return rows;
}

/** The tabs of a worktree and everything nested beneath it that still matter. */
function liveTabsInSubtree(node: WorktreeNode, agentTabs: Record<string, AgentTab[]>): AgentTab[] {
  return [
    ...liveTabs(agentTabs[node.worktree.id] ?? []),
    ...node.children.flatMap((child) => liveTabsInSubtree(child, agentTabs)),
  ];
}

/** Drops `cleared` agents: viewed or never reporting, so not worth a row. */
function liveTabs(tabs: AgentTab[]): AgentTab[] {
  return tabs.filter((tab) => statusRank(tab.status) > 0);
}

/** Status → SwiftUI color, matching the app's dot palette (red/amber/green). */
export function statusColor(status: AgentStatus | null): WidgetStatusColor {
  if (status === "attention") return "red";
  if (status === "running") return "orange";
  if (status === "done") return "green";
  return "gray";
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replaceAll(/\s+/gu, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}
