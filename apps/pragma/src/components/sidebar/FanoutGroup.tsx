import type { AgentStatus, Fanout, FanoutMember } from "@pragma/constants";
import { GitFork } from "lucide-react";

import { AgentStatusDot } from "@/components/AgentStatusDot";
import { WorktreeRowFrame } from "@/components/sidebar/WorktreeRowFrame";
import { Button } from "@/components/ui/button";
import {
  fanoutForParent,
  fanoutStatusLabel,
  memberLabel,
  memberTooltip,
  orderedMembers,
} from "@/lib/fanout";
import { useFanouts } from "@/state/fanouts-context";
import { useKanban } from "@/state/kanban-context";
import { useWorkspace } from "@/state/workspace-context";

/**
 * The active fanout a worktree is the parent of, if any.
 *
 * The lookup lives here rather than in the worktree row so an ordinary row
 * stays ordinary: most worktrees are not fanout parents.
 */
export function useFanoutForParent(worktreeId: string): Fanout | null {
  const { fanouts } = useFanouts();
  return fanoutForParent(fanouts, worktreeId);
}

/**
 * The fanout marker on a parent worktree row: one icon, no row of its own.
 *
 * The prompt-derived title lives in the tooltip and the comparison view — a
 * dedicated row for it pushed every attempt a level deeper for no information
 * the parent row could not carry.
 */
export function FanoutIndicator({ worktreeId, label }: { worktreeId: string; label: string }) {
  const fanouts = useFanouts();
  const fanout = useFanoutForParent(worktreeId);
  if (!fanout) return null;
  return (
    <Button
      aria-label={`Open fanout comparison for ${label}`}
      size="icon-xs"
      title={`${fanout.title} · ${fanoutStatusLabel(fanout)}`}
      variant="ghost"
      onClick={(event) => {
        event.stopPropagation();
        fanouts.openComparison(fanout.id);
      }}
    >
      <GitFork className="text-muted-foreground" />
    </Button>
  );
}

/**
 * The attempt rows under a parent worktree, when it has a fanout.
 *
 * Rendered from the durable record rather than inferred from sibling
 * worktrees: a `parentId` alone cannot tell an attempt apart from an ordinary
 * nested worktree, a retry, or finished history.
 */
export function FanoutMembersSlot({ worktreeId, depth }: { worktreeId: string; depth: number }) {
  const fanout = useFanoutForParent(worktreeId);
  if (!fanout) return null;
  return orderedMembers(fanout).map((member) => (
    <FanoutMemberRow key={member.id} depth={depth} member={member} projectId={fanout.projectId} />
  ));
}

/**
 * The agent indicator a member's own status implies. Member status is the
 * fanout's vocabulary; the dot is the agent's, and only three of them overlap.
 */
function agentStatusFor(member: FanoutMember): AgentStatus | null {
  switch (member.status) {
    case "running":
      return "running";
    case "attention":
      return "attention";
    case "done":
    case "selected":
      return "done";
    default:
      return null;
  }
}

/**
 * One attempt row. Labelled by harness and model — the generated branch and
 * worktree name carry nothing a person chose, and would crowd out what does.
 *
 * Reuses {@link WorktreeRowFrame}, the same shell ordinary worktree rows use,
 * so an attempt sits naturally under its parent instead of reading as a
 * foreign list. The worktree branch icon is swapped for the fan-out glyph.
 */
function FanoutMemberRow({
  member,
  depth,
  projectId,
}: {
  member: FanoutMember;
  depth: number;
  projectId: string;
}) {
  const workspace = useWorkspace();
  const kanban = useKanban();
  const selected = member.worktreeId ? workspace.selectedWorktreeId === member.worktreeId : false;

  const select = () => {
    if (!member.worktreeId) return;
    // Selecting an attempt is an ordinary worktree selection, plus its agent
    // tab: the tab is the session a person opened, so opening the worktree
    // without it strands them on an empty shell.
    if (member.tabId) {
      void workspace.activateTabLocation(projectId, member.worktreeId, member.tabId);
    } else {
      workspace.selectWorktree(member.worktreeId);
    }
    kanban.exitBoard();
  };

  return (
    <WorktreeRowFrame
      depth={depth}
      selected={selected}
      disabled={!member.worktreeId}
      title={memberTooltip(member)}
      caret={<span className="w-3" />}
      onActivate={select}
      icon={<GitFork className="size-3.5 shrink-0 text-muted-foreground" />}
      label={<span className="truncate">{memberLabel(member)}</span>}
      status={<AgentStatusDot status={agentStatusFor(member)} />}
    />
  );
}
