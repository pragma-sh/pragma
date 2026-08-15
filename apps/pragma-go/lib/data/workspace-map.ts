import type { AgentReportPayload, Project, Tab, Worktree } from "@pragma/constants";

import { statusRank } from "../agent-status";
import { runtimeAgentId } from "../launch-form";
import { agentSessionTitle } from "../tab-title";
import { normalizeQuestionOptions, type AgentTab, type InboxItem } from "../types";
import { worktreeLabel } from "../worktree-tree";

// Pure, RN-free mapping from the host's WorkspaceSnapshot + live agent statuses
// into the view models the existing screens already consume (AgentTab,
// InboxItem). Projects and Worktrees pass through untouched (they ARE the
// domain types); the status/attention overlay comes from the `agentStatus`
// subscription. Kept side-effect-free so the derivation is unit tested without
// a device.

/**
 * Builds the per-worktree agent-tab map from the snapshot's open tabs, so the
 * phone mirrors every agent session the host has open — the tab is the sync
 * qualifier, active or inactive. A terminal tab qualifies when it is tagged
 * with an agent (`Tab.agentId`, set for any catalog agent at launch, first- or
 * third-party) or has a live status report (a manually started agent that
 * reports through its plugin). Closing the tab drops it from the snapshot and
 * therefore from this map; a report for a tab the snapshot no longer carries
 * is ignored. Status reports only overlay the dot/attention state — a session
 * with no report yet still appears, dotless.
 *
 * Titles are the desktop's agent-tab titles (see `agentSessionTitle`), never a
 * live shell OSC title: agent tabs ignore OSC titles on the desktop too.
 */
export function agentTabsBySnapshot(
  tabs: Tab[],
  statuses: AgentReportPayload[],
): Record<string, AgentTab[]> {
  const reportsByTabId = reportsByTab(statuses);
  const result: Record<string, AgentTab[]> = {};
  for (const tab of newestTabsFirst(tabs)) {
    if (tab.kind !== "terminal") continue;
    const report = reportsByTabId.get(tab.id);
    const agent = report?.agent ?? (tab.agentId ? runtimeAgentId(tab.agentId) : null);
    if (!agent) continue;
    const agentTab: AgentTab = {
      id: tab.id,
      worktreeId: tab.worktreeId,
      agent,
      title: agentSessionTitle(tab.title, report?.sessionName),
      status: report?.status ?? "cleared",
      attentionKind: report?.attentionKind ?? null,
    };
    (result[tab.worktreeId] ??= []).push(agentTab);
  }
  return result;
}

/** One open agent tab's merged report: identity plus its most-urgent status. */
interface MergedReport {
  agent: string;
  status: AgentTab["status"] | null;
  attentionKind: AgentTab["attentionKind"];
  /** Last agent-reported session name, used when the tab carries no title yet. */
  sessionName: string | null;
}

/**
 * Collapses each tab's reports into one. Any report (even a status-less
 * session-name one) supplies the agent identity; the status/attention fields
 * come from the highest-priority report so several reporting agents on one tab
 * roll up the same way the desktop aggregates them (attention > running >
 * done > cleared).
 */
function reportsByTab(statuses: AgentReportPayload[]): Map<string, MergedReport> {
  const result = new Map<string, MergedReport>();
  for (const report of statuses) {
    const existing = result.get(report.tabId);
    if (existing) {
      mergeReport(existing, report);
    } else {
      result.set(report.tabId, firstReport(report));
    }
  }
  return result;
}

/** The merged report a tab starts with, from its first report. */
function firstReport(report: AgentReportPayload): MergedReport {
  return {
    agent: report.agent,
    status: report.status ?? null,
    attentionKind: report.attentionKind ?? null,
    sessionName: report.sessionName ?? null,
  };
}

/** Folds a further report for the same tab into the merged one, in place. */
function mergeReport(merged: MergedReport, report: AgentReportPayload): void {
  merged.sessionName = report.sessionName ?? merged.sessionName;
  if (statusRank(report.status ?? null) <= statusRank(merged.status)) return;
  merged.status = report.status ?? null;
  merged.attentionKind = report.attentionKind ?? null;
}

/** Orders tabs newest-first so the freshest session leads each group. */
function newestTabsFirst(tabs: Tab[]): Tab[] {
  // Hermes does not yet provide Array.prototype.toSorted.
  // oxlint-disable-next-line unicorn/no-array-sort
  return [...tabs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
 * rather than throwing. `status` may be null (a session-name-only report).
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
    (typeof value.status === "string" || value.status === null)
  );
}
