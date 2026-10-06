import type { Fanout } from "@pragma-sh/constants";
import { fanoutStatusLabel, memberLabel } from "@pragma-sh/fanout-view";
import { router } from "expo-router";
import type { ReactNode } from "react";

import { useFanoutGrouping } from "@/lib/fanouts-context";
import { fanoutDotStatus } from "@/lib/fanout-status";
import { useThemeColors } from "@/lib/theme";
import type { WorktreeNode } from "@/lib/worktree-tree";
import { AgentStatusDot } from "./AgentStatusDot";
import { IconSymbol } from "./IconSymbol";
import { NavGroup, NavRow } from "./NavRow";
import { WorktreeNavRow } from "./WorktreeNavRow";

/** Opens a fanout's compare view. */
function openFanout(fanoutId: string): void {
  router.push({ pathname: "/fanout/[fanoutId]", params: { fanoutId } });
}

/**
 * A fanout's group row: its title, an attempt-count rollup, and the combined
 * status of its attempts. Tapping opens the compare view.
 */
function FanoutNavRow({ fanout }: { fanout: Fanout }) {
  const colors = useThemeColors();
  return (
    <NavRow
      leading={
        <IconSymbol
          color={colors.mutedForeground}
          fallback="⑃"
          name="arrow.triangle.branch"
          size={18}
        />
      }
      onPress={() => openFanout(fanout.id)}
      subtitle={`Fanout · ${fanout.members.length} attempts · ${fanoutStatusLabel(fanout)}`}
      title={fanout.title}
      trailing={<AgentStatusDot status={fanoutDotStatus(fanout)} />}
    />
  );
}

/**
 * A list of worktrees with fanouts folded in, the way the desktop sidebar
 * groups them.
 *
 * Attempt worktrees are dropped from the plain rows — an attempt is not a
 * worktree anyone made by hand, and five generated `fanout/…` branches would
 * bury the ones that are — and each fanout appears once, as a group row right
 * after the worktree that owns it.
 */
export function WorktreeGroup({ nodes, title }: { nodes: WorktreeNode[]; title: string }) {
  const grouping = useFanoutGrouping();
  const rows = groupedWorktreeRows(nodes, grouping);
  if (rows.length === 0) return null;
  return <NavGroup title={title}>{rows}</NavGroup>;
}

/**
 * Plain worktree and fanout rows in order: one row per worktree, minus the
 * attempts, with each parent's active fanout directly after it.
 */
function groupedWorktreeRows(
  nodes: WorktreeNode[],
  grouping: ReturnType<typeof useFanoutGrouping>,
): ReactNode[] {
  const rows: ReactNode[] = [];
  for (const node of nodes) {
    if (grouping.attemptIds.has(node.worktree.id)) continue;
    rows.push(<WorktreeNavRow key={node.worktree.id} worktree={node.worktree} />);
    const fanout = grouping.fanoutForParent(node.worktree.id);
    if (fanout) rows.push(<FanoutNavRow key={fanout.id} fanout={fanout} />);
  }
  return rows;
}

/**
 * On a worktree's own screen, how it relates to a fanout: the active fanout it
 * is the parent of, or the fanout it is an attempt in. Nothing for an ordinary
 * worktree.
 */
export function FanoutMembershipGroup({ worktreeId }: { worktreeId: string }) {
  const grouping = useFanoutGrouping();
  const owned = grouping.fanoutForParent(worktreeId);
  const attempt = grouping.memberForWorktree(worktreeId);
  if (owned) {
    return (
      <NavGroup title="Fanout">
        <FanoutNavRow fanout={owned} />
      </NavGroup>
    );
  }
  if (!attempt) return null;
  return (
    <NavGroup
      footer={`This worktree is the ${memberLabel(attempt.member)} attempt.`}
      title="Fanout"
    >
      <FanoutNavRow fanout={attempt.fanout} />
    </NavGroup>
  );
}
