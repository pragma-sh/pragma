import type { AgentReportPayload, Project, Tab, Worktree } from "@pragma/constants";

import { normalizeQuestionOptions, type AgentTab, type InboxItem } from "../types";
import { displayTabTitle } from "../tab-title";

// Pure, RN-free mapping from the host's WorkspaceSnapshot + live agent statuses
// into the view models the existing screens already consume (AgentTab,
// InboxItem). Projects and Worktrees pass through untouched (they ARE the
// domain types); the agent overlay comes from the `agentStatus` subscription.
// Kept side-effect-free so the derivation is unit tested without a device.

/** Human label for a worktree row: its title, else its branch. */
export function worktreeLabel(worktree: Worktree): string {
  return worktree.title ?? worktree.branch;
}

/**
 * Builds the per-worktree agent-tab map by overlaying live agent statuses onto
 * the snapshot's tabs. Only tabs that currently host a reporting agent appear
 * (mirrors the fixtures, where a tab with no agent shows no status dot).
 */
export function agentTabsBySnapshot(
  tabs: Tab[],
  statuses: AgentReportPayload[],
  liveTitles: Readonly<Record<string, string>> = {},
): Record<string, AgentTab[]> {
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const result: Record<string, AgentTab[]> = {};
  for (const status of newestStatusesFirst(statuses, tabsById)) {
    if (!status.status) {
      // A stored session-name-only report (no status yet) has no dot to show.
      continue;
    }
    const tab = tabsById.get(status.tabId);
    const agentTab: AgentTab = {
      id: status.tabId,
      worktreeId: status.worktreeId,
      agent: status.agent,
      title: displayTabTitle(liveTitles[status.tabId] ?? tab?.title),
      status: status.status,
      attentionKind: status.attentionKind ?? null,
    };
    (result[status.worktreeId] ??= []).push(agentTab);
  }
  return result;
}

/**
 * Derives inbox items from every agent status currently requesting attention,
 * carrying the routing fields (`tabId`, `requestId`) a live reply needs.
 */
export function inboxFromStatuses(
  statuses: AgentReportPayload[],
  projects: Project[],
  worktrees: Worktree[],
  tabs: Tab[],
): InboxItem[] {
  const locations = {
    projectsById: new Map(projects.map((project) => [project.id, project])),
    worktreesById: new Map(worktrees.map((worktree) => [worktree.id, worktree])),
  };
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  return newestStatusesFirst(statuses, tabsById)
    .map((status) => inboxItemForStatus(status, locations))
    .filter((item): item is InboxItem => item !== null);
}

function inboxItemForStatus(
  status: AgentReportPayload,
  locations: {
    projectsById: ReadonlyMap<string, Project>;
    worktreesById: ReadonlyMap<string, Worktree>;
  },
): InboxItem | null {
  if (!isAttentionStatus(status)) return null;
  const worktree = locations.worktreesById.get(status.worktreeId);
  const project = worktree ? locations.projectsById.get(worktree.projectId) : undefined;
  const base = {
    id: `${status.tabId}:${status.agent}:${status.requestId}`,
    kind: status.attentionKind,
    projectId: project?.id ?? "",
    projectName: project?.name ?? "",
    worktreeId: status.worktreeId,
    worktreeLabel: worktree ? worktreeLabel(worktree) : status.worktreeId,
    agent: status.agent,
    tabId: status.tabId,
    requestId: status.requestId,
  };
  return status.attentionKind === "command"
    ? commandInboxItem(base, status.command)
    : questionInboxItem(base, status.question, status.options);
}

function isAttentionStatus(status: AgentReportPayload): status is AgentReportPayload & {
  attentionKind: NonNullable<AgentReportPayload["attentionKind"]>;
  requestId: string;
} {
  return Boolean(status.status === "attention" && status.attentionKind && status.requestId);
}

function commandInboxItem(
  base: Omit<InboxItem, "prompt" | "detail" | "options">,
  command: string | null | undefined,
): InboxItem {
  return {
    ...base,
    prompt: command ?? "Approve command?",
    ...(command ? { detail: command } : {}),
  };
}

function questionInboxItem(
  base: Omit<InboxItem, "prompt" | "detail" | "options">,
  question: string | null | undefined,
  rawOptions: unknown,
): InboxItem {
  const options = normalizeQuestionOptions(rawOptions);
  return { ...base, prompt: question ?? "", ...(options ? { options } : {}) };
}

function newestStatusesFirst(
  statuses: AgentReportPayload[],
  tabsById: ReadonlyMap<string, Tab>,
): AgentReportPayload[] {
  // Hermes does not yet provide Array.prototype.toSorted.
  // oxlint-disable-next-line unicorn/no-array-sort
  return [...statuses].sort((left, right) =>
    (tabsById.get(right.tabId)?.createdAt ?? "").localeCompare(
      tabsById.get(left.tabId)?.createdAt ?? "",
    ),
  );
}

/**
 * Tolerantly extracts an AgentReportPayload list from an `agentStatus`
 * subscription payload. The wire shape isn't strongly typed at the SDK boundary,
 * so we accept a bare array or a `{ agents | statuses }` wrapper and drop any
 * entry missing the routing fields — an unknown shape degrades to no statuses
 * rather than throwing.
 */
export function parseAgentStatuses(payload: unknown): AgentReportPayload[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? (asArray(payload.statuses) ?? asArray(payload.agents) ?? [])
      : [];
  return list.filter(isAgentReport);
}

/** Converts completed reports for one viewed tab to their non-indicating state. */
export function markTabStatusesSeen(
  statuses: AgentReportPayload[],
  tabId: string,
): AgentReportPayload[] {
  return statuses.map((status) =>
    status.tabId === tabId && status.status === "done" ? { ...status, status: "cleared" } : status,
  );
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAgentReport(value: unknown): value is AgentReportPayload {
  if (!isRecord(value)) return false;
  return (
    typeof value.agent === "string" &&
    typeof value.worktreeId === "string" &&
    typeof value.tabId === "string" &&
    typeof value.status === "string"
  );
}
