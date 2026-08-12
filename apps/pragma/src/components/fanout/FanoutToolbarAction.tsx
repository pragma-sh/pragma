import { Columns3, GitFork } from "lucide-react";
import { useState } from "react";

import { PickImplementationDialog } from "@/components/fanout/PickImplementationDialog";
import { Button } from "@/components/ui/button";
import { fanoutForParent, memberForWorktree } from "@/lib/fanout";
import { useFanouts } from "@/state/fanouts-context";
import { useWorkspace } from "@/state/workspace-context";

/**
 * The fanout action for the selected location, sitting immediately left of the
 * editor launcher.
 *
 * A parent gets **Compare implementations**; an attempt gets **Pick
 * implementation**. Everything else gets nothing — a parent owns at most one
 * fanout, so there is never a chooser.
 */
export function FanoutToolbarAction() {
  const workspace = useWorkspace();
  const fanouts = useFanouts();
  const [picking, setPicking] = useState(false);
  const worktreeId = workspace.selectedWorktreeId;
  if (!worktreeId) return null;

  const parentFanout = fanoutForParent(fanouts.fanouts, worktreeId);
  if (parentFanout) {
    return (
      <Button size="sm" variant="ghost" onClick={() => fanouts.openComparison(parentFanout.id)}>
        <Columns3 className="size-3.5" />
        Compare implementations
      </Button>
    );
  }

  const attempt = memberForWorktree(fanouts.fanouts, worktreeId);
  if (!attempt) return null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setPicking(true)}>
        <GitFork className="size-3.5" />
        Pick implementation
      </Button>
      <PickImplementationDialog
        fanout={attempt.fanout}
        memberId={attempt.member.id}
        open={picking}
        onOpenChange={setPicking}
      />
    </>
  );
}
