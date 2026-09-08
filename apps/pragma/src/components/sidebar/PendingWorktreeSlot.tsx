import { CircleAlert, Loader2 } from "lucide-react";

import { WorktreeRowFrame } from "@/components/sidebar/WorktreeRowFrame";
import { useWorktreeCreation } from "@/state/worktree-creation-context";
import { useWorkspace } from "@/state/workspace-context";

/**
 * The optimistic sidebar row for a worktree that is still being created. It
 * renders wherever the real row will land — under the parent it was created
 * from — with a spinner in place of the branch glyph, so the creation can be
 * left running while the user works elsewhere. Clicking it reopens the
 * progress screen.
 */
export function PendingWorktreeSlot({
  parentWorktreeId,
  depth,
}: {
  parentWorktreeId: string;
  depth: number;
}) {
  const workspace = useWorkspace();
  const { creation, viewCreation } = useWorktreeCreation();
  if (
    !creation ||
    creation.parentWorktreeId !== parentWorktreeId ||
    creation.projectId !== workspace.selectedProjectId
  ) {
    return null;
  }
  const failed = creation.error !== null;
  return (
    <WorktreeRowFrame
      caret={<span className="w-3" />}
      data-testid="pending-worktree-row"
      depth={depth}
      icon={
        failed ? (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        )
      }
      label={
        <span className="truncate" title={creation.branch}>
          {creation.label}
        </span>
      }
      selected={creation.viewing}
      onActivate={viewCreation}
    />
  );
}
