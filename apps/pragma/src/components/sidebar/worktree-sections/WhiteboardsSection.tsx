import { useState } from "react";
import { PencilRuler, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type { Whiteboard } from "@pragma-sh/constants";
import type { PluginWorktree } from "@pragma-sh/plugin";

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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { errorMessage } from "@/lib/errors";
import { deleteWhiteboard, listWhiteboards } from "@/lib/tauri";
import { useKanban } from "@/state/kanban-context";
import { useWorkspace } from "@/state/workspace-context";
import { createWorktreeListStore } from "@/state/worktree-list-store";
import { SectionItem } from "./SectionItem";
import type { BuiltInWorktreeSection } from "./types";
import { useInvalidateOnChange, useWorktreeTabSignature } from "./use-section-refresh";

/**
 * How often visible worktree rows re-list their boards. The host announces no
 * whiteboard changes, so a board an agent or `pragma-cli whiteboard create`
 * writes is otherwise invisible until a tab happens to open or close.
 */
const WHITEBOARD_POLL_MS = 4000;

const whiteboards = createWorktreeListStore<Whiteboard>(
  (worktreeId) => listWhiteboards(worktreeId),
  { pollMs: WHITEBOARD_POLL_MS },
);

function WhiteboardsBody({ worktree }: { worktree: PluginWorktree }) {
  const items = whiteboards.useList(worktree.id) ?? [];
  const [deleteTarget, setDeleteTarget] = useState<Whiteboard | null>(null);
  const kanban = useKanban();
  const workspace = useWorkspace();

  const confirmDelete = async (): Promise<void> => {
    const board = deleteTarget;
    setDeleteTarget(null);
    if (!board) return;
    try {
      await deleteWhiteboard(worktree.id, board.id);
      await Promise.all(
        workspace.projectTabs
          .filter((tab) => tab.whiteboardId === board.id)
          .map((tab) => workspace.closeTab(tab.id)),
      );
      whiteboards.invalidate(worktree.id);
    } catch (cause) {
      toast.error(`Failed to delete whiteboard: ${errorMessage(cause)}`);
    }
  };

  return (
    <>
      {items.map((whiteboard) => (
        <ContextMenu key={whiteboard.id}>
          <ContextMenuTrigger asChild>
            <SectionItem
              onClick={() => {
                kanban.exitBoard();
                void workspace.openWhiteboard(whiteboard.id, whiteboard.title, worktree.id);
              }}
            >
              <PencilRuler className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{whiteboard.title}</span>
            </SectionItem>
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
    </>
  );
}

/**
 * The worktree's whiteboards. Inventory only — creation lives in the new-tab
 * and pane menus. Right-click a board to delete it.
 */
export const whiteboardsSection: BuiltInWorktreeSection = {
  id: "whiteboards",
  title: "Whiteboards",
  icon: PencilRuler,
  useCount: (worktree) => {
    // Boards live in the host database, not in files, so tab churn is the signal.
    const tabs = useWorktreeTabSignature(worktree.id, "whiteboard");
    useInvalidateOnChange(tabs, () => whiteboards.invalidate(worktree.id));
    return whiteboards.useList(worktree.id)?.length ?? null;
  },
  Body: WhiteboardsBody,
};
