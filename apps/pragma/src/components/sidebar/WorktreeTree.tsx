import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@iconify/react";
import { constants, type Worktree } from "@pragma/constants";
import { ChevronRight, Copy, EyeOff, GitBranch, GitBranchPlus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { WorktreeDeleteDialog } from "@/components/dialogs/WorktreeDeleteDialog";
import { buildWorktreeTree, type WorktreeNode } from "@/lib/worktree-tree";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/state/workspace-context";

const editorLaunchers = constants.editorLaunchers.options;

interface WorktreeTreeProps {
  onCreateChild: () => void;
}

export function WorktreeTree({ onCreateChild }: WorktreeTreeProps) {
  const workspace = useWorkspace();
  const worktrees = workspace.selectedProjectId
    ? (workspace.worktrees[workspace.selectedProjectId] ?? [])
    : [];
  const tree = buildWorktreeTree(worktrees, { predicate: (w) => !w.hidden });
  const hidden = worktrees.filter((w) => w.hidden);
  const [showHidden, setShowHidden] = useState(false);

  if (tree.length === 0 && hidden.length === 0) {
    return <p className="px-2 py-6 text-sm text-muted-foreground">No worktrees loaded.</p>;
  }

  return (
    <div className="space-y-1">
      {tree.map((node) => (
        <WorktreeRow key={node.worktree.id} depth={0} node={node} onCreateChild={onCreateChild} />
      ))}
      {hidden.length > 0 ? (
        <div className="pt-1">
          <button
            className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-sidebar-accent/60"
            onClick={() => setShowHidden((value) => !value)}
          >
            <ChevronRight className={cn("size-3 opacity-60", showHidden && "rotate-90")} />
            {showHidden ? "Hide" : "Show"} {hidden.length} hidden
          </button>
          {showHidden
            ? hidden.map((worktree) => (
                <HiddenWorktreeRow
                  key={worktree.id}
                  onUnhide={() => void workspace.hideWorktree(worktree.id, false)}
                  worktree={worktree}
                />
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

function WorktreeRow({
  node,
  depth,
  onCreateChild,
}: {
  node: WorktreeNode;
  depth: number;
  onCreateChild: () => void;
}) {
  const workspace = useWorkspace();
  const selected = workspace.selectedWorktreeId === node.worktree.id;
  const label = node.worktree.isMain ? "main" : (node.worktree.title ?? node.worktree.branch);
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(label);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasChildren = node.children.length > 0;
  const isMain = node.worktree.isMain;

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  const startRename = useCallback(() => {
    setRenameValue(node.worktree.title ?? node.worktree.branch);
    setRenaming(true);
  }, [node.worktree.title, node.worktree.branch]);

  const commitRename = useCallback(() => {
    setRenaming(false);
    const next = renameValue.trim();
    const current = node.worktree.title ?? node.worktree.branch;
    if (next === current) {
      return;
    }
    void workspace.renameWorktree(node.worktree.id, next);
  }, [node.worktree.id, node.worktree.title, node.worktree.branch, renameValue, workspace]);

  const cancelRename = useCallback(() => {
    setRenaming(false);
  }, []);

  const copyToClipboard = useCallback(async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(message);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm",
              selected
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent/70",
            )}
            style={{ paddingLeft: 8 + depth * 14 }}
          >
            {hasChildren ? (
              <button
                aria-expanded={expanded}
                aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
                className="flex w-3 items-center justify-center"
                onClick={() => setExpanded((value) => !value)}
              >
                <ChevronRight className={cn("size-3 opacity-60", expanded && "rotate-90")} />
              </button>
            ) : (
              <span className="w-3" />
            )}
            <button
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => workspace.selectWorktree(node.worktree.id)}
              onDoubleClick={isMain ? undefined : startRename}
            >
              <GitBranch className="size-3.5 shrink-0" />
              {renaming ? (
                <input
                  ref={inputRef}
                  aria-label={`Rename ${label}`}
                  className="w-0 min-w-0 flex-1 rounded bg-white/10 px-1 text-left text-sm text-foreground outline-none ring-1 ring-ring"
                  value={renameValue}
                  onBlur={commitRename}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      cancelRename();
                    }
                  }}
                />
              ) : (
                <span className="truncate">{label}</span>
              )}
            </button>
            {isMain ? null : (
              <Button
                aria-label={`Create child worktree from ${label}`}
                className="opacity-0 group-hover:opacity-100"
                size="icon-xs"
                variant="ghost"
                onClick={() => {
                  workspace.selectWorktree(node.worktree.id);
                  onCreateChild();
                }}
              >
                <GitBranchPlus />
              </Button>
            )}
            {isMain ? null : (
              <Button
                aria-label={`Delete worktree ${label}`}
                className="opacity-0 group-hover:opacity-100"
                size="icon-xs"
                variant="ghost"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="text-destructive" />
              </Button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={isMain} onSelect={isMain ? undefined : startRename}>
            <Pencil />
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              void copyToClipboard(node.worktree.path, "Copied worktree path");
            }}
          >
            <Copy />
            Copy worktree path
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              void copyToClipboard(node.worktree.branch, "Copied branch name");
            }}
          >
            <Copy />
            Copy branch name
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Icon
                className="size-4"
                icon={editorLaunchers[0]?.brandIcon ?? "lucide:square-terminal"}
                style={{ color: editorLaunchers[0]?.brandColor }}
              />
              Open in editor
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {editorLaunchers.map((editor) => (
                <ContextMenuItem
                  key={editor.id}
                  onSelect={() => void workspace.openWorktreeInEditor(node.worktree.id, editor.id)}
                >
                  <Icon
                    className="size-4"
                    icon={editor.brandIcon}
                    style={{ color: editor.brandColor }}
                  />
                  {editor.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void workspace.hideWorktree(node.worktree.id, true)}>
            <EyeOff />
            Hide
          </ContextMenuItem>
          {isMain ? null : (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                <Trash2 />
                Delete
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {!isMain ? (
        <WorktreeDeleteDialog
          open={deleteOpen}
          trigger={null}
          worktreeId={node.worktree.id}
          worktreeLabel={label}
          onOpenChange={setDeleteOpen}
        />
      ) : null}
      {expanded &&
        node.children.map((child) => (
          <WorktreeRow
            key={child.worktree.id}
            depth={depth + 1}
            node={child}
            onCreateChild={onCreateChild}
          />
        ))}
    </div>
  );
}

function HiddenWorktreeRow({ worktree, onUnhide }: { worktree: Worktree; onUnhide: () => void }) {
  const label = worktree.title ?? worktree.branch;
  return (
    <div className="mt-1 flex items-center justify-between rounded-md px-2 py-1 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-1.5">
        <GitBranch className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <Button aria-label={`Show ${label}`} size="icon-xs" variant="ghost" onClick={onUnhide}>
        <EyeOff />
      </Button>
    </div>
  );
}
