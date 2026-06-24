import { useEffect, useState } from "react";
import { GitBranchPlus, MessageSquarePlus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CreateProjectDialog } from "@/components/dialogs/CreateProjectDialog";
import { CreateWorktreeDialog } from "@/components/dialogs/CreateWorktreeDialog";
import { NewChatDialog } from "@/components/dialogs/NewChatDialog";
import { ProjectSwitcher } from "@/components/sidebar/ProjectSwitcher";
import { WorktreeTree } from "@/components/sidebar/WorktreeTree";
import { useProjectCycle } from "@/hooks/use-project-cycle";
import { consumePendingNewChat, NEW_CHAT_EVENT, type NewChatDeepLinkDetail } from "@/lib/deep-link";
import { useWorkspace } from "@/state/workspace-context";

export function ProjectSidebar() {
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const [newChatDialogOpen, setNewChatDialogOpen] = useState(false);
  const [newChatInitial, setNewChatInitial] = useState<NewChatDeepLinkDetail | null>(null);
  const workspace = useWorkspace();
  const cycle = useProjectCycle();

  useEffect(() => {
    function openDialog() {
      setProjectDialogOpen(true);
    }
    window.addEventListener("pragma:create-project", openDialog);
    return () => window.removeEventListener("pragma:create-project", openDialog);
  }, []);

  // A `pragma://open` deep link (without auto-submit) opens the new-chat dialog
  // prefilled with the link's values. The workspace owns deep-link handling but
  // the sidebar owns this dialog, so requests arrive via `requestNewChat`: drain
  // any buffered request on mount (a cold-start deep link is handled before this
  // listener exists) and also listen for live ones.
  useEffect(() => {
    function openPrefilled(detail: NewChatDeepLinkDetail) {
      setNewChatInitial(detail);
      setNewChatDialogOpen(true);
    }
    function onEvent(event: Event) {
      // Clear the buffer too so a later remount doesn't reopen the same request.
      consumePendingNewChat();
      openPrefilled((event as CustomEvent<NewChatDeepLinkDetail>).detail);
    }
    const pending = consumePendingNewChat();
    if (pending) {
      openPrefilled(pending);
    }
    window.addEventListener(NEW_CHAT_EVENT, onEvent);
    return () => window.removeEventListener(NEW_CHAT_EVENT, onEvent);
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
        <div className="flex items-center gap-0.5">
          <Button
            aria-label="Start new chat"
            disabled={!workspace.selectedWorktree}
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              setNewChatInitial(null);
              setNewChatDialogOpen(true);
            }}
          >
            <MessageSquarePlus />
          </Button>
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
      <NewChatDialog
        open={newChatDialogOpen}
        onOpenChange={setNewChatDialogOpen}
        initial={newChatInitial}
      />
    </aside>
  );
}
