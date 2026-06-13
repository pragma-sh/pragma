import { useEffect, useState } from "react";
import { GitBranchPlus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CreateProjectDialog } from "@/components/dialogs/CreateProjectDialog";
import { CreateWorktreeDialog } from "@/components/dialogs/CreateWorktreeDialog";
import { ProjectSwitcher } from "@/components/sidebar/ProjectSwitcher";
import { WorktreeTree } from "@/components/sidebar/WorktreeTree";
import { useProjectCycle } from "@/hooks/use-project-cycle";
import { useWorkspace } from "@/state/workspace-context";

export function ProjectSidebar() {
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const workspace = useWorkspace();
  const cycle = useProjectCycle();

  useEffect(() => {
    function openDialog() {
      setProjectDialogOpen(true);
    }
    window.addEventListener("pragma:create-project", openDialog);
    return () => window.removeEventListener("pragma:create-project", openDialog);
  }, []);

  return (
    <aside
      className="bg-sidebar flex w-72 shrink-0 touch-pan-y flex-col border-r border-sidebar-border"
      onWheel={cycle.onWheel}
      onTouchStart={cycle.onTouchStart}
      onTouchEnd={cycle.onTouchEnd}
    >
      <div className="space-y-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Projects
            </p>
            <h2 className="truncate text-sm font-semibold">
              {workspace.activeProject?.name ?? "Pragma"}
            </h2>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setProjectDialogOpen(true)}
            aria-label="Add project"
          >
            <Plus />
          </Button>
        </div>
      </div>
      <Separator />
      <div className="flex items-center justify-between px-3 py-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Worktrees
        </p>
        <Button
          aria-label="Create worktree"
          disabled={!workspace.selectedWorktree}
          size="icon-sm"
          variant="ghost"
          onClick={() => setWorktreeDialogOpen(true)}
        >
          <GitBranchPlus />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        <WorktreeTree onCreateChild={() => setWorktreeDialogOpen(true)} />
      </div>
      <Separator />
      <div className="p-3">
        <ProjectSwitcher />
      </div>
      <CreateProjectDialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen} />
      <CreateWorktreeDialog open={worktreeDialogOpen} onOpenChange={setWorktreeDialogOpen} />
    </aside>
  );
}
