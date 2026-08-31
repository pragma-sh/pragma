import type { AgentStatus, Fanout, FanoutMember } from "@pragma/constants";
import { GitFork } from "lucide-react";
import { toast } from "sonner";

import { AgentStatusDot } from "@/components/AgentStatusDot";
import { ShortcutHint } from "@/components/ShortcutHint";
import { WorktreeRowFrame } from "@/components/sidebar/WorktreeRowFrame";
import { IconButton } from "@/components/ui/icon-button";
import {
  fanoutForParent,
  fanoutStatusLabel,
  memberLabel,
  memberTooltip,
  orderedMembers,
} from "@/lib/fanout";
import { errorMessage } from "@/lib/errors";
import { restoreFanoutTab } from "@/lib/tauri";
import { useTabAgentStatus } from "@/state/agent-status-store";
import { useFanouts } from "@/state/fanouts-context";
import { useKanban } from "@/state/kanban-context";
import { useWorkspace } from "@/state/workspace-context";
import { useShortcutHint, useWorktreeShortcutIndex } from "@/lib/shortcut-hints";

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
    <IconButton
      aria-label={`Open fanout comparison for ${label}`}
      label={`${fanout.title} · ${fanoutStatusLabel(fanout)}`}
      size="icon-xs"
      variant="ghost"
      onClick={(event) => {
        event.stopPropagation();
        fanouts.openComparison(fanout.id);
      }}
    >
      <GitFork className="text-muted-foreground" />
    </IconButton>
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
 * Active fanout states can seed an indicator before runtime reports arrive.
 * Completed states deliberately do not: runtime `done` is cleared when viewed,
 * while the durable fanout member remains completed forever.
 */
function activeAgentStatusFor(member: FanoutMember): AgentStatus | null {
  switch (member.status) {
    case "running":
      return "running";
    case "attention":
      return "attention";
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
  const shortcutIndex = useWorktreeShortcutIndex(member.worktreeId);
  const shortcutHint = useShortcutHint("worktree", shortcutIndex);
  const runtimeStatus = useTabAgentStatus(member.tabId);

  const select = () => {
    const worktreeId = member.worktreeId;
    if (!worktreeId) return;
    const tabId = member.tabId;
    if (tabId) {
      // Do not select the worktree before its host-created tab is restored: that
      // exposes the generic no-tabs welcome screen while adoption is in flight.
      const openAgentTab = async () => {
        const known = workspace.projectTabs.some(
          (tab) => tab.id === tabId && tab.worktreeId === worktreeId,
        );
        if (!known) {
          await restoreFanoutTab(projectId, worktreeId, tabId);
        }
        await workspace.activateTabLocation(projectId, worktreeId, tabId);
      };
      void openAgentTab().catch((cause) => toast.error(errorMessage(cause)));
    } else {
      workspace.selectWorktree(worktreeId, projectId);
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
      label={<span className="min-w-0 flex-1 truncate">{memberLabel(member)}</span>}
      status={<AgentStatusDot status={runtimeStatus ?? activeAgentStatusFor(member)} />}
      trailing={<ShortcutHint value={shortcutHint} />}
    />
  );
}
