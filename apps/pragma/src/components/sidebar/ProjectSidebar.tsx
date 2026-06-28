import { useEffect, useState } from "react";
import { LayoutGrid, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CreateProjectDialog } from "@/components/dialogs/CreateProjectDialog";
import { CreateWorktreeDialog } from "@/components/dialogs/CreateWorktreeDialog";
import { ProjectSwitcher } from "@/components/sidebar/ProjectSwitcher";
import { WorktreeTree } from "@/components/sidebar/WorktreeTree";
import { useProjectCycle } from "@/hooks/use-project-cycle";
import { startWindowDrag } from "@/lib/window-drag";
import { useKanban } from "@/state/kanban-context";
import { useWorkspace } from "@/state/workspace-context";

export function ProjectSidebar() {
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const workspace = useWorkspace();
  const kanban = useKanban();
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
      {/* Draggable titlebar strip: clears the inset macOS traffic lights and
          gives the frameless window a drag handle. The project row itself is
          the drag handle so content sits right under the reserved titlebar. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- window-drag handle is a pointer-only OS affordance with no ARIA role or keyboard equivalent */}
      <div
        className="titlebar-pad flex items-center justify-between px-3 pt-2 pb-1"
        onMouseDown={startWindowDrag}
      >
        <h2 className="truncate text-sm font-semibold text-sidebar-foreground">
          {workspace.activeProject?.name ?? "Pragma"}
        </h2>
        <div className="flex items-center gap-0.5">
          <Button
            aria-label="Toggle prompt board"
            aria-pressed={kanban.mode === "kanban"}
            disabled={!workspace.selectedProjectId}
            size="icon-sm"
            variant={kanban.mode === "kanban" ? "secondary" : "ghost"}
            onClick={() => (kanban.mode === "kanban" ? kanban.exitBoard() : kanban.openBoard())}
          >
            <LayoutGrid />
          </Button>
          <Button
            aria-label="Add project"
            size="icon-sm"
            variant="ghost"
            onClick={() => setProjectDialogOpen(true)}
          >
            <Plus />
          </Button>
        </div>
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
