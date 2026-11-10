import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { FolderPlus, GitBranchPlus, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PlusCloseIcon } from "@/components/ui/plus-close-icon";
import { Separator } from "@/components/ui/separator";
import { TOUR_ANCHOR } from "@/components/onboarding/WorkspaceTour";
import { CreateProjectDialog } from "@/components/dialogs/CreateProjectDialog";
import { CreateWorktreeDialog } from "@/components/dialogs/CreateWorktreeDialog";
import { InitGitDialog } from "@/components/dialogs/InitGitDialog";
import { InstallUpdateButton } from "@/components/sidebar/InstallUpdateButton";
import { PluginSidebarCards } from "@/components/sidebar/PluginSidebarCards";
import { ProjectSwitcher } from "@/components/sidebar/ProjectSwitcher";
import { WorktreeTree } from "@/components/sidebar/WorktreeTree";
import { useProjectCycle } from "@/hooks/use-project-cycle";
import { CREATE_PROJECT_EVENT, mainWorktreeLabel, projectIsGit } from "@/lib/non-git-project";
import { startWindowDrag } from "@/lib/window-drag";
import { useLeftSidebar } from "@/state/left-sidebar-context";
import { useWorkspace } from "@/state/workspace-context";
import { useWorktreeCreation } from "@/state/worktree-creation-context";
import { instantTransition, motionTransition, useMotionTransition } from "@/lib/motion";

/** Width of the collapsed rail, in px — matches the `w-9` the strip used to hard-code. */
const COLLAPSED_WIDTH = 36;

export function ProjectSidebar() {
  const [resizing, setResizing] = useState(false);
  const workspace = useWorkspace();
  const dialogs = useSidebarDialogs();
  const cycle = useProjectCycle();
  const { collapsed, width, toggleCollapsed, setWidth } = useLeftSidebar();
  // Dragging the handle must track the pointer exactly, so the spring is
  // suppressed for the duration of the drag rather than chasing it a frame behind.
  const panelTransition = useMotionTransition(
    resizing ? instantTransition : motionTransition.panel,
  );

  const projectId = workspace.selectedProjectId;
  const mainWorktreeId = projectId
    ? ((workspace.worktrees[projectId] ?? []).find((worktree) => worktree.isMain)?.id ?? null)
    : null;

  return (
    // One element whose width animates, rather than two components swapped at
    // the collapse boundary: swapping would make the rail jump to its new size
    // in a single frame, and the centre pane (with the terminal's
    // ResizeObserver behind it) would jump with it.
    <motion.aside
      animate={{ width: collapsed ? COLLAPSED_WIDTH : width }}
      className="bg-sidebar relative flex shrink-0 touch-pan-y flex-col overflow-hidden border-r border-sidebar-border"
      initial={false}
      onWheel={cycle.onWheel}
      onTouchStart={cycle.onTouchStart}
      onTouchEnd={cycle.onTouchEnd}
      transition={panelTransition}
    >
      {collapsed ? (
        <CollapsedProjectSidebar onExpand={toggleCollapsed} />
      ) : (
        <ExpandedProjectSidebar
          mainWorktreeId={mainWorktreeId}
          newWorktreeLabel={`New worktree off ${mainWorktreeLabel(workspace.activeProject)}`}
          onAddProject={dialogs.openProjectDialog}
          onCreateChild={dialogs.openWorktreeDialog}
          onNewWorktree={() => dialogs.openWorktreeDialog(mainWorktreeId)}
          onResize={setWidth}
          onResizeEnd={() => setResizing(false)}
          onResizeStart={() => setResizing(true)}
          onToggleCollapsed={toggleCollapsed}
        />
      )}
      <CreateProjectDialog
        open={dialogs.projectDialogOpen}
        onOpenChange={dialogs.setProjectDialogOpen}
      />
      <CreateWorktreeDialog
        open={dialogs.worktreeDialogOpen}
        onOpenChange={dialogs.setWorktreeDialogOpen}
        parentWorktreeId={dialogs.worktreeParentId ?? mainWorktreeId ?? undefined}
      />
      <InitGitDialog
        projectId={dialogs.initGitProjectId}
        onInitialized={dialogs.continueAfterInit}
        onOpenChange={(open) => !open && dialogs.cancelInit()}
      />
    </motion.aside>
  );
}

/**
 * The sidebar's two creation dialogs: which is open, and which worktree a new
 * one branches from.
 *
 * Both are opened from more than one place — the titlebar, the plus menu, a
 * worktree row, the `pragma:create-project` event the welcome screen fires, and
 * the draft a failed creation republishes — so the wiring lives here rather
 * than in the component's body.
 */
function useSidebarDialogs(): {
  projectDialogOpen: boolean;
  setProjectDialogOpen: (open: boolean) => void;
  openProjectDialog: () => void;
  worktreeDialogOpen: boolean;
  worktreeParentId: string | null;
  /** Opens the create dialog branching from `parentWorktreeId`, or — on a
   *  project that is not a git repository — offers to initialize one first. */
  openWorktreeDialog: (parentWorktreeId: string | null) => void;
  setWorktreeDialogOpen: (open: boolean) => void;
  /** The plain project the init-git prompt is asking about. */
  initGitProjectId: string | null;
  /** Opens the create dialog the prompt interrupted, now that git exists. */
  continueAfterInit: () => void;
  cancelInit: () => void;
} {
  const workspace = useWorkspace();
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const [worktreeParentId, setWorktreeParentId] = useState<string | null>(null);
  const [initGitProjectId, setInitGitProjectId] = useState<string | null>(null);
  const { draft } = useWorktreeCreation();
  const activeProject = workspace.activeProject;

  const openWorktreeDialog = useCallback(
    (parentWorktreeId: string | null) => {
      setWorktreeParentId(parentWorktreeId);
      if (activeProject && !projectIsGit(activeProject)) {
        setInitGitProjectId(activeProject.id);
        return;
      }
      setWorktreeDialogOpen(true);
    },
    [activeProject],
  );

  useEffect(() => {
    function openDialog() {
      setProjectDialogOpen(true);
    }
    window.addEventListener(CREATE_PROJECT_EVENT, openDialog);
    return () => window.removeEventListener(CREATE_PROJECT_EVENT, openDialog);
  }, []);

  // "Try again" on a failed creation republishes its request as a draft: reopen
  // the dialog on the same parent so the user can fix the input and resubmit.
  // The dialog itself consumes the draft to seed its fields.
  useEffect(() => {
    if (!draft) return;
    openWorktreeDialog(draft.parentWorktreeId);
  }, [draft, openWorktreeDialog]);

  return {
    projectDialogOpen,
    setProjectDialogOpen,
    openProjectDialog: () => setProjectDialogOpen(true),
    worktreeDialogOpen,
    worktreeParentId,
    openWorktreeDialog,
    setWorktreeDialogOpen: (open: boolean) => {
      setWorktreeDialogOpen(open);
      if (!open) setWorktreeParentId(null);
    },
    initGitProjectId,
    continueAfterInit: () => {
      setInitGitProjectId(null);
      setWorktreeDialogOpen(true);
    },
    cancelInit: () => {
      setInitGitProjectId(null);
      setWorktreeParentId(null);
    },
  };
}

/** The expanded sidebar body: resize handle, titlebar, worktree tree, and cards. */
function ExpandedProjectSidebar({
  mainWorktreeId,
  newWorktreeLabel,
  onAddProject,
  onCreateChild,
  onNewWorktree,
  onResize,
  onResizeEnd,
  onResizeStart,
  onToggleCollapsed,
}: {
  mainWorktreeId: string | null;
  newWorktreeLabel: string;
  onAddProject: () => void;
  onCreateChild: (parentWorktreeId: string) => void;
  onNewWorktree: () => void;
  onResize: (width: number) => void;
  onResizeEnd: () => void;
  onResizeStart: () => void;
  onToggleCollapsed: () => void;
}) {
  const workspace = useWorkspace();
  return (
    <>
      <SidebarResizeHandle
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        onResizeStart={onResizeStart}
      />
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
        <div className="flex shrink-0 items-center">
          <Button
            aria-label={newWorktreeLabel}
            data-tour={TOUR_ANCHOR.newWorktree}
            disabled={!mainWorktreeId}
            size="icon-sm"
            title={newWorktreeLabel}
            variant="ghost"
            onClick={onNewWorktree}
          >
            <Plus />
          </Button>
          <Button
            aria-label="Collapse project sidebar"
            size="icon-sm"
            variant="ghost"
            onClick={onToggleCollapsed}
          >
            <PanelLeftClose />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        <WorktreeTree onCreateChild={onCreateChild} />
      </div>
      <div className="p-3">
        <PluginSidebarCards />
        <Separator className="my-3" />
        <InstallUpdateButton />
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <ProjectSwitcher />
          </div>
          <AddMenu
            newWorktreeLabel={newWorktreeLabel}
            worktreeDisabled={!mainWorktreeId}
            onAddProject={onAddProject}
            onNewWorktree={onNewWorktree}
          />
        </div>
      </div>
    </>
  );
}

/** The "+" menu beside the project switcher: new worktree off main, or add a project. */
function AddMenu({
  newWorktreeLabel,
  worktreeDisabled,
  onAddProject,
  onNewWorktree,
}: {
  newWorktreeLabel: string;
  worktreeDisabled: boolean;
  onAddProject: () => void;
  onNewWorktree: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Add project or worktree"
          data-tour={TOUR_ANCHOR.addProject}
          size="icon-sm"
          variant="ghost"
        >
          <PlusCloseIcon open={open} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top">
        <DropdownMenuItem disabled={worktreeDisabled} onSelect={onNewWorktree}>
          <GitBranchPlus />
          {newWorktreeLabel}
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
    // On macOS the collapsed strip sits under the inset traffic lights (their
    // x-inset overlaps a 36px rail), so the strip itself is the drag handle
    // and the expand button drops below the lights.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- window-drag handle is a pointer-only OS affordance with no ARIA role or keyboard equivalent
    <motion.div
      animate={{ opacity: 1 }}
      className="titlebar-pad flex flex-1 flex-col items-center pb-2"
      initial={{ opacity: 0 }}
      onMouseDown={startWindowDrag}
      transition={motionTransition.fast}
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
      <div className="mt-auto">
        <InstallUpdateButton compact />
      </div>
    </motion.div>
  );
}

/** Right-edge drag handle that resizes the (left-anchored) sidebar. */
function SidebarResizeHandle({
  onResize,
  onResizeStart,
  onResizeEnd,
}: {
  onResize: (width: number) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
}) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  return (
    <div
      aria-hidden
      className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-primary/40"
      onPointerDown={(event) => {
        const parent = event.currentTarget.parentElement;
        if (!parent) {
          return;
        }
        dragRef.current = {
          startX: event.clientX,
          startWidth: parent.getBoundingClientRect().width,
        };
        onResizeStart();
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
        onResizeEnd();
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}
