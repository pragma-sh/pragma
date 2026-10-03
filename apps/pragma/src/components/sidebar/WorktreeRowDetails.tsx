import { useMemo } from "react";
import { Icon } from "@iconify/react";
import { Bot, GitPullRequestCreate } from "lucide-react";

import { AgentIcon } from "@/components/agents/AgentIcon";
import { AgentProgressLine } from "@/components/sidebar/AgentProgressLine";
import { WorktreeActivityLine } from "@/components/sidebar/WorktreeActivityLine";
import { useAgentsList } from "@/hooks/use-agents-list";
import { findReportingAgent, reportingAgentName } from "@/lib/agent-lookup";
import {
  AGENT_STATUS_RANK,
  isVisibleAgentStatus,
  type VisibleAgentStatus,
} from "@/lib/agent-status-style";
import { useAgentStatusSnapshot } from "@/state/agent-status-store";
import { useKanban } from "@/state/kanban-context";
import { usePullRequestDrafted } from "@/state/pull-request-draft-store";
import { useWorkspace } from "@/state/workspace-context";
import { useLatestWorktreeActivity, type WorktreeActivity } from "@/state/worktree-activity-store";

/** One agent tab in a worktree, as the detailed row lists it. */
interface WorktreeAgent {
  tabId: string;
  agent: string;
  status: VisibleAgentStatus;
}

/** The agents reporting in one worktree, most urgent first. */
function useWorktreeAgents(worktreeId: string): WorktreeAgent[] {
  const entries = useAgentStatusSnapshot();
  return useMemo(
    () =>
      entries
        .filter((entry) => entry.worktreeId === worktreeId)
        .flatMap((entry) =>
          isVisibleAgentStatus(entry.status)
            ? [{ tabId: entry.tabId, agent: entry.agent, status: entry.status }]
            : [],
        )
        .toSorted((a, b) => AGENT_STATUS_RANK[a.status] - AGENT_STATUS_RANK[b.status]),
    [entries, worktreeId],
  );
}

/** What a detailed row has to show beyond its title line. */
export interface WorktreeRowDetailsData {
  agents: WorktreeAgent[];
  activity: WorktreeActivity | null;
  prNumber: number | null;
  /** An AI-drafted PR is waiting to be opened, and the branch has no PR yet. */
  readyForPr: boolean;
}

/** Gathers a row's details; {@link hasWorktreeRowDetails} says whether any exist. */
export function useWorktreeRowDetails(
  worktreeId: string,
  prNumber: number | null,
  hasPr: boolean,
): WorktreeRowDetailsData {
  const drafted = usePullRequestDrafted(worktreeId);
  return {
    agents: useWorktreeAgents(worktreeId),
    activity: useLatestWorktreeActivity(worktreeId),
    prNumber,
    readyForPr: drafted && !hasPr,
  };
}

/** Whether a row has anything to show under its title line. */
export function hasWorktreeRowDetails(data: WorktreeRowDetailsData): boolean {
  return (
    data.agents.length > 0 || data.activity !== null || data.prNumber !== null || data.readyForPr
  );
}

/**
 * The PR pill: a GitHub mark and the number. The title line's icon already
 * carries the PR's lifecycle color, so the pill does not repeat that glyph.
 */
function PullRequestPill({ number }: { number: number }) {
  return (
    <span
      aria-label={`Pull request #${number}`}
      className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums"
    >
      <Icon aria-hidden className="size-3" icon="simple-icons:github" />#{number}
    </span>
  );
}

/** A drafted PR not yet opened: the worktree's next step is opening it. */
function ReadyForPullRequestLine() {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <GitPullRequestCreate aria-hidden className="size-3 shrink-0 text-success" />
      <span className="truncate">Ready for PR</span>
    </span>
  );
}

/** One agent tab in the row; clicking it opens that tab. */
function WorktreeAgentLine({ worktreeId, agent }: { worktreeId: string; agent: WorktreeAgent }) {
  const workspace = useWorkspace();
  const kanban = useKanban();
  const agents = useAgentsList();
  const config = findReportingAgent(agents, agent.agent);
  const name = reportingAgentName(agents, agent.agent);
  const projectId = workspace.selectedProjectId;
  // The hover fill is a shade off the row's own background (selected or
  // hovered), so the agent under the pointer reads as its own target in the card.
  return (
    <button
      aria-label={`Open ${name}`}
      className="-mx-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground"
      type="button"
      onClick={() => {
        if (!projectId) return;
        kanban.exitBoard();
        void workspace.activateTabLocation(projectId, worktreeId, agent.tabId);
      }}
    >
      {config ? (
        <AgentIcon agent={config} className="size-3 shrink-0" />
      ) : (
        <Bot className="size-3 shrink-0 text-skill" />
      )}
      <AgentProgressLine
        agent={agent.agent}
        className="min-w-0 flex-1"
        status={agent.status}
        tabId={agent.tabId}
        worktreeId={worktreeId}
      />
    </button>
  );
}

/**
 * The detailed layout's extra lines under a worktree's title: its pull request
 * number and any commit / push / PR action in flight (or, between actions,
 * "Ready for PR" once a PR is drafted but not yet opened), then one line per agent
 * with its status (and System 1 activity + progress when configured).
 */
export function WorktreeRowDetails({
  worktreeId,
  data,
}: {
  worktreeId: string;
  data: WorktreeRowDetailsData;
}) {
  const { agents, activity, prNumber, readyForPr } = data;
  return (
    <>
      {prNumber !== null || activity ? (
        <span className="flex min-w-0 items-center gap-2">
          {prNumber !== null ? <PullRequestPill number={prNumber} /> : null}
          {activity ? <WorktreeActivityLine activity={activity} className="min-w-0" /> : null}
        </span>
      ) : null}
      {readyForPr && !activity ? <ReadyForPullRequestLine /> : null}
      {agents.map((agent) => (
        <WorktreeAgentLine
          agent={agent}
          key={`${agent.tabId}\0${agent.agent}`}
          worktreeId={worktreeId}
        />
      ))}
    </>
  );
}
