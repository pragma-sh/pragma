import { useEffect, useState } from "react";
import { ChevronDown, Clock, LayoutGrid, Plus, Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { CreateProjectDialog } from "@/components/dialogs/CreateProjectDialog";
import { CreateWorktreeDialog } from "@/components/dialogs/CreateWorktreeDialog";
import { PairDeviceDialog } from "@/components/dialogs/PairDeviceDialog";
import { ProjectSwitcher } from "@/components/sidebar/ProjectSwitcher";
import { WorktreeTree } from "@/components/sidebar/WorktreeTree";
import { useProjectCycle } from "@/hooks/use-project-cycle";
import { startWindowDrag } from "@/lib/window-drag";
import { RenderPluginContribution, usePluginSidebarCards } from "@/plugins/rendering";
import { useKanban } from "@/state/kanban-context";
import { useWorkspace } from "@/state/workspace-context";
import { cn } from "@/lib/utils";

export function ProjectSidebar() {
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const [pairDialogOpen, setPairDialogOpen] = useState(false);
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
            aria-label="Toggle automations"
            aria-pressed={kanban.mode === "automations"}
            size="icon-sm"
            variant={kanban.mode === "automations" ? "secondary" : "ghost"}
            onClick={() =>
              kanban.mode === "automations" ? kanban.exitBoard() : kanban.openAutomations()
            }
          >
            <Clock />
          </Button>
          <Button
            aria-label="Pair a device"
            size="icon-sm"
            variant="ghost"
            onClick={() => setPairDialogOpen(true)}
          >
            <Smartphone />
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
      <div className="p-3">
        <PluginSidebarCards />
        <Separator className="my-3" />
        <ProjectSwitcher />
      </div>
      <CreateProjectDialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen} />
      <CreateWorktreeDialog open={worktreeDialogOpen} onOpenChange={setWorktreeDialogOpen} />
      <PairDeviceDialog open={pairDialogOpen} onOpenChange={setPairDialogOpen} />
    </aside>
  );
}

function PluginSidebarCards() {
  const workspace = useWorkspace();
  const cards = usePluginSidebarCards(workspace.selectedProjectId);
  if (cards.length === 0) {
    return null;
  }
  return (
    <div className="mb-3 space-y-2">
      {cards.map((card) => (
        <PluginSidebarCardItem card={card} key={card.key} />
      ))}
    </div>
  );
}

function PluginSidebarCardItem({
  card,
}: {
  card: ReturnType<typeof usePluginSidebarCards>[number];
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible
      className="rounded-lg border border-sidebar-border bg-card shadow-sm"
      data-slot="plugin-sidebar-card"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger
        aria-label={`Toggle ${card.contribution.title} panel`}
        className="group flex w-full items-center justify-between gap-2 px-3 py-3 text-left"
      >
        <h3 className="truncate text-xs font-semibold text-muted-foreground">
          {card.contribution.title}
        </h3>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open ? "rotate-0" : "rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        <RenderPluginContribution
          component={card.contribution.component}
          config={card.record.config}
          pluginId={card.pluginId}
          resetKey={card.key}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}
