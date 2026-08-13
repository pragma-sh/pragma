import { router } from "expo-router";

import { useWorktreeStatus } from "@/lib/data/data-context";
import { useThemeColors } from "@/lib/theme";
import type { Worktree } from "@/lib/types";
import { worktreeLabel } from "@/lib/worktree-tree";
import { AgentStatusDot } from "./AgentStatusDot";
import { IconSymbol } from "./IconSymbol";
import { NavRow } from "./NavRow";

/**
 * A worktree row for the drill-down. Its status dot aggregates the worktree AND
 * everything nested beneath it, matching the desktop sidebar rollup.
 */
export function WorktreeNavRow({ worktree }: { worktree: Worktree }) {
  const status = useWorktreeStatus(worktree.id);
  const colors = useThemeColors();
  return (
    <NavRow
      leading={
        <IconSymbol
          color={colors.mutedForeground}
          fallback={worktree.isMain ? "★" : "⎇"}
          name={worktree.isMain ? "circle.fill" : "arrow.triangle.branch"}
          size={18}
        />
      }
      onPress={() =>
        router.push({ pathname: "/worktree/[worktreeId]", params: { worktreeId: worktree.id } })
      }
      subtitle={worktree.isMain ? worktree.branch : undefined}
      title={worktreeLabel(worktree)}
      trailing={<AgentStatusDot status={status} />}
    />
  );
}
