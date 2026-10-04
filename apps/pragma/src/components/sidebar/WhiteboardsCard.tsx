import { useEffect, useState } from "react";

import type { Whiteboard } from "@pragma-sh/constants";
import { ChevronDown, PencilRuler, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { errorMessage } from "@/lib/errors";
import { deleteWhiteboard, listWhiteboards } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useKanban } from "@/state/kanban-context";
import { useWorkspace } from "@/state/workspace-context";

/**
 * Sidebar inventory of the current worktree's whiteboards.
 *
 * The card is inventory only — creation lives in the new-tab and pane menus —
 * and it renders **nothing** until the selected worktree's list has resolved to
 * at least one board: no empty shell during the initial load, no "no
 * whiteboards yet" placeholder, nothing at all without a selected worktree.
 */
export function WhiteboardsCard() {
  const [open, setOpen] = useState(true);
  const [resolved, setResolved] = useState<{
    worktreeId: string;
    whiteboards: Whiteboard[];
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<Whiteboard | null>(null);
  const kanban = useKanban();
  const workspace = useWorkspace();
  const worktreeId = workspace.selectedWorktreeId;

  useEffect(() => {
    if (!worktreeId) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    void listWhiteboards(worktreeId)
      .then((result) => {
        if (!cancelled) setResolved({ worktreeId, whiteboards: result });
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setResolved(null);
      });
    return () => {
      cancelled = true;
    };
  }, [revision, workspace.projectTabs, worktreeId]);

  if (!worktreeId) return null;

  // Hide the card until the selected worktree's own list has resolved
  // non-empty: a stale result from a previous worktree, an empty list, or a
  // load error all mean "no card", and none of them may flash an empty card
  // mid-switch or during the initial fetch.
  const whiteboards =
    resolved && resolved.worktreeId === worktreeId && resolved.whiteboards.length > 0
      ? resolved.whiteboards
      : null;
  if (!whiteboards) return null;

  const confirmDelete = async (): Promise<void> => {
    const board = deleteTarget;
    setDeleteTarget(null);
    if (!board) return;
    try {
      await deleteWhiteboard(worktreeId, board.id);
      await Promise.all(
        workspace.projectTabs
          .filter((tab) => tab.whiteboardId === board.id)
          .map((tab) => workspace.closeTab(tab.id)),
      );
      setRevision((value) => value + 1);
    } catch (cause) {
      toast.error(`Failed to delete whiteboard: ${errorMessage(cause)}`);
    }
  };

  return (
    <Collapsible
      className="mb-2 rounded-lg border border-sidebar-border bg-card shadow-sm"
      onOpenChange={setOpen}
      open={open}
    >
      <div className="flex items-center px-1 pr-2">
        <CollapsibleTrigger
          aria-label="Toggle whiteboards panel"
          className="group flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-3 text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            <PencilRuler className="size-3.5 text-muted-foreground" />
            <span className="truncate text-xs font-semibold text-muted-foreground">
              Whiteboards
            </span>
            <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
              {whiteboards.length}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open ? "rotate-0" : "rotate-90",
            )}
          />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="px-2 pb-2">
        <div className="space-y-0.5">
          {whiteboards.map((whiteboard) => (
            <ContextMenu key={whiteboard.id}>
              <ContextMenuTrigger asChild>
                <button
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => {
                    kanban.exitBoard();
                    void workspace.openWhiteboard(whiteboard.id, whiteboard.title);
                  }}
                  type="button"
                >
                  <PencilRuler className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{whiteboard.title}</span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setDeleteTarget(whiteboard)}
                >
                  <Trash2 />
                  Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
      </CollapsibleContent>
      <AlertDialog onOpenChange={(value) => !value && setDeleteTarget(null)} open={!!deleteTarget}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete whiteboard?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `“${deleteTarget.title}” will be permanently deleted.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Collapsible>
  );
}
