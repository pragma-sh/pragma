import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  FolderPlus,
  GitBranchPlus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { CreateProjectDialog } from "@/components/dialogs/CreateProjectDialog";
import { CreateWorktreeDialog } from "@/components/dialogs/CreateWorktreeDialog";
import { ProjectSwitcher } from "@/components/sidebar/ProjectSwitcher";
import { OpenPortsCard } from "@/components/sidebar/OpenPortsCard";
import { ScratchpadsCard } from "@/components/sidebar/ScratchpadsCard";
import { WorktreeTree } from "@/components/sidebar/WorktreeTree";
import { useProjectCycle } from "@/hooks/use-project-cycle";
import { startWindowDrag } from "@/lib/window-drag";
import { RenderPluginContribution, usePluginSidebarCards } from "@/plugins/rendering";
import { useLeftSidebar } from "@/state/left-sidebar-context";
import { useWorkspace } from "@/state/workspace-context";
import { cn } from "@/lib/utils";

export function ProjectSidebar() {
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const [worktreeParentId, setWorktreeParentId] = useState<string | null>(null);
  const workspace = useWorkspace();
  const cycle = useProjectCycle();
  const { collapsed, width, toggleCollapsed, setWidth } = useLeftSidebar();

  const projectId = workspace.selectedProjectId;
  const mainWorktreeId = projectId
    ? ((workspace.worktrees[projectId] ?? []).find((worktree) => worktree.isMain)?.id ?? null)
    : null;

  useEffect(() => {
    function openDialog() {
      setProjectDialogOpen(true);
    }
    window.addEventListener("pragma:create-project", openDialog);
    return () => window.removeEventListener("pragma:create-project", openDialog);
  }, []);

  if (collapsed) {
    return <CollapsedProjectSidebar onExpand={toggleCollapsed} />;
  }

  return (
    <aside
      className="bg-sidebar relative flex shrink-0 touch-pan-y flex-col border-r border-sidebar-border"
      style={{ width }}
      onWheel={cycle.onWheel}
      onTouchStart={cycle.onTouchStart}
      onTouchEnd={cycle.onTouchEnd}
    >
      <SidebarResizeHandle onResize={setWidth} />
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
        <Button
          aria-label="Collapse project sidebar"
          size="icon-sm"
          variant="ghost"
          onClick={toggleCollapsed}
        >
          <PanelLeftClose />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        <WorktreeTree
          onCreateChild={(parentWorktreeId) => {
            setWorktreeParentId(parentWorktreeId);
            setWorktreeDialogOpen(true);
          }}
        />
      </div>
      <div className="p-3">
        <OpenPortsCard />
        <ScratchpadsCard />
        <PluginSidebarCards />
        <Separator className="my-3" />
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <ProjectSwitcher />
          </div>
          <AddMenu
            worktreeDisabled={!mainWorktreeId}
            onAddProject={() => setProjectDialogOpen(true)}
            onNewWorktree={() => {
              setWorktreeParentId(mainWorktreeId);
              setWorktreeDialogOpen(true);
            }}
          />
        </div>
      </div>
      <CreateProjectDialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen} />
      <CreateWorktreeDialog
        open={worktreeDialogOpen}
        onOpenChange={(open) => {
          setWorktreeDialogOpen(open);
          if (!open) setWorktreeParentId(null);
        }}
        parentWorktreeId={worktreeParentId ?? mainWorktreeId ?? undefined}
      />
    </aside>
  );
}

/** The "+" menu beside the project switcher: new worktree off main, or add a project. */
function AddMenu({
  worktreeDisabled,
  onAddProject,
  onNewWorktree,
}: {
  worktreeDisabled: boolean;
  onAddProject: () => void;
  onNewWorktree: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="Add project or worktree" size="icon-sm" variant="ghost">
          <Plus />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top">
        <DropdownMenuItem disabled={worktreeDisabled} onSelect={onNewWorktree}>
          <GitBranchPlus />
          New worktree off main
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onAddProject}>
          <FolderPlus />
          Add project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The collapsed strip: a single expand button, mirroring the right sidebar. */
function CollapsedProjectSidebar({ onExpand }: { onExpand: () => void }) {
  return (
    <div className="bg-sidebar flex w-9 shrink-0 flex-col border-r border-sidebar-border">
      {/* On macOS the collapsed strip sits under the inset traffic lights (their
          x-inset overlaps a 36px rail), so the strip itself is the drag handle
          and the expand button drops below the lights. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- window-drag handle is a pointer-only OS affordance with no ARIA role or keyboard equivalent */}
      <div
        className="titlebar-pad flex flex-1 flex-col items-center pb-2"
        onMouseDown={startWindowDrag}
      >
        <Button
          aria-label="Expand project sidebar"
          className="mt-2"
          onClick={onExpand}
          size="icon-sm"
          variant="ghost"
        >
          <PanelLeftOpen />
        </Button>
      </div>
    </div>
  );
}

/** Right-edge drag handle that resizes the (left-anchored) sidebar. */
function SidebarResizeHandle({ onResize }: { onResize: (width: number) => void }) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  return (
    <div
      aria-hidden
      className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize hover:bg-primary/40"
      onPointerDown={(event) => {
        const parent = event.currentTarget.parentElement;
        if (!parent) {
          return;
        }
        dragRef.current = {
          startX: event.clientX,
          startWidth: parent.getBoundingClientRect().width,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) {
          return;
        }
        onResize(drag.startWidth + (event.clientX - drag.startX));
      }}
      onPointerUp={(event) => {
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
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
