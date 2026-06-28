import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Icon } from "@iconify/react";
import { constants, type Worktree } from "@pragma/constants";
import {
  ChevronRight,
  Copy,
  EyeOff,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  Pencil,
  Trash2,
} from "lucide-react";
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
import { AgentStatusDot } from "@/components/AgentStatusDot";
import { WorktreeDeleteDialog } from "@/components/dialogs/WorktreeDeleteDialog";
import { worktreesMergedStatus } from "@/lib/tauri";
import { buildWorktreeTree, type WorktreeNode } from "@/lib/worktree-tree";
import { commitOnEnterCancelOnEscape } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { useKanban } from "@/state/kanban-context";
import { useWorktreeAgentStatus } from "@/state/agent-status-store";
import { useWorkspace } from "@/state/workspace-context";

const editorLaunchers = constants.editorLaunchers.options;
const MERGED_STATUS_REFRESH_INTERVAL_MS = 2000;

interface WorktreeTreeProps {
  onCreateChild: () => void;
}

export function WorktreeTree({ onCreateChild }: WorktreeTreeProps) {
  const workspace = useWorkspace();
  const worktrees = useMemo(
    () =>
      workspace.selectedProjectId ? (workspace.worktrees[workspace.selectedProjectId] ?? []) : [],
    [workspace.selectedProjectId, workspace.worktrees],
  );
  const tree = buildWorktreeTree(worktrees, { predicate: (w) => !w.hidden });
  const hidden = worktrees.filter((w) => w.hidden);
  const [showHidden, setShowHidden] = useState(false);
  const [mergedByWorktreeId, setMergedByWorktreeId] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const childWorktrees = worktrees.filter((worktree) => !worktree.isMain && worktree.parentId);
    let cancelled = false;

    async function refreshMergedStatus() {
      try {
        const merged = await worktreesMergedStatus(childWorktrees.map((w) => w.id));
        if (!cancelled) {
          setMergedByWorktreeId(merged);
        }
      } catch {
        if (!cancelled) {
          setMergedByWorktreeId({});
        }
      }
    }

    if (childWorktrees.length === 0) {
      setMergedByWorktreeId({});
      return;
    }

    void refreshMergedStatus();
    const interval = setInterval(
      () => void refreshMergedStatus(),
      MERGED_STATUS_REFRESH_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [worktrees]);

  if (tree.length === 0 && hidden.length === 0) {
    return <p className="px-2 py-6 text-sm text-muted-foreground">No worktrees loaded.</p>;
  }

  return (
    <div className="space-y-1">
      {tree.map((node) => (
        <WorktreeRow
          key={node.worktree.id}
          depth={0}
          mergedByWorktreeId={mergedByWorktreeId}
          node={node}
          onCreateChild={onCreateChild}
        />
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
                  merged={mergedByWorktreeId[worktree.id] === true}
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

/** Copy a value to the clipboard and toast the result (or an error). */
async function copyToClipboard(value: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(message);
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Inline-rename state for a worktree row (focus/select, commit/cancel). */
function useWorktreeRename(worktree: Worktree): {
  renaming: boolean;
  renameValue: string;
  setRenameValue: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  startRename: () => void;
  commitRename: () => void;
  cancelRename: () => void;
} {
  const workspace = useWorkspace();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(worktree.title ?? worktree.branch);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);
  const startRename = useCallback(() => {
    setRenameValue(worktree.title ?? worktree.branch);
    setRenaming(true);
  }, [worktree.title, worktree.branch]);
  const commitRename = useCallback(() => {
    setRenaming(false);
    const next = renameValue.trim();
    const current = worktree.title ?? worktree.branch;
    if (next === current) return;
    void workspace.renameWorktree(worktree.id, next);
  }, [worktree.id, worktree.title, worktree.branch, renameValue, workspace]);
  const cancelRename = useCallback(() => setRenaming(false), []);
  return {
    renaming,
    renameValue,
    setRenameValue,
    inputRef,
    startRename,
    commitRename,
    cancelRename,
  };
}

type RenameApi = ReturnType<typeof useWorktreeRename>;

/** Resolve a worktree's display label (`main` for the main worktree). */
function worktreeLabel(worktree: Worktree): string {
  return worktree.isMain ? "main" : (worktree.title ?? worktree.branch);
}

interface WorktreeRowLabelProps extends ComponentPropsWithoutRef<"div"> {
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  isMain: boolean;
  label: string;
  merged: boolean;
  WorktreeIcon: typeof GitBranch;
  agentStatus: ReturnType<typeof useWorktreeAgentStatus>;
  rename: RenameApi;
  startRename: () => void;
  toggleExpanded: () => void;
  handleSelect: () => void;
  handleCreateChild: () => void;
  openDelete: () => void;
  selected: boolean;
}

/** Class for a worktree row's container, highlighting the selected one. */
function worktreeRowClass(selected: boolean): string {
  return selected
    ? "bg-sidebar-accent text-sidebar-accent-foreground"
    : "text-sidebar-foreground hover:bg-sidebar-accent/70";
}

/** The expand/collapse caret for a worktree row (or a spacer for childless rows). */
function WorktreeExpandCaret({
  hasChildren,
  expanded,
  label,
  toggleExpanded,
}: {
  hasChildren: boolean;
  expanded: boolean;
  label: string;
  toggleExpanded: () => void;
}) {
  if (!hasChildren) return <span className="w-3" />;
  return (
    <button
      aria-expanded={expanded}
      aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
      className="flex w-3 items-center justify-center"
      onClick={toggleExpanded}
    >
      <ChevronRight className={cn("size-3 opacity-60", expanded && "rotate-90")} />
    </button>
  );
}

/** The worktree name: an inline rename input when renaming, otherwise the label. */
function WorktreeNameField({ rename, label }: { rename: RenameApi; label: string }) {
  if (!rename.renaming) return <span className="truncate">{label}</span>;
  return (
    <input
      ref={rename.inputRef}
      aria-label={`Rename ${label}`}
      className="w-0 min-w-0 flex-1 rounded bg-muted px-1 text-left text-sm text-foreground outline-none ring-1 ring-ring"
      value={rename.renameValue}
      onBlur={rename.commitRename}
      onChange={(event) => rename.setRenameValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={commitOnEnterCancelOnEscape(rename.commitRename, rename.cancelRename)}
    />
  );
}

/** The clickable primary area: branch icon, name/rename field, agent status dot. */
function WorktreeRowPrimaryButton({
  isMain,
  merged,
  WorktreeIcon,
  agentStatus,
  handleSelect,
  startRename,
  rename,
  label,
}: {
  isMain: boolean;
  merged: boolean;
  WorktreeIcon: typeof GitBranch;
  agentStatus: ReturnType<typeof useWorktreeAgentStatus>;
  handleSelect: () => void;
  startRename: () => void;
  rename: RenameApi;
  label: string;
}) {
  return (
    <button
      className="flex min-w-0 flex-1 items-center gap-2 text-left"
      onClick={handleSelect}
      onDoubleClick={isMain ? undefined : startRename}
    >
      <WorktreeIcon className={cn("size-3.5 shrink-0", merged && "text-success")} />
      <WorktreeNameField label={label} rename={rename} />
      <AgentStatusDot status={agentStatus} />
    </button>
  );
}

/** Row actions: an always-visible new-worktree button on main, hover-revealed
 *  create-child and delete buttons on nested worktrees. */
function WorktreeRowActions({
  isMain,
  label,
  handleCreateChild,
  openDelete,
}: {
  isMain: boolean;
  label: string;
  handleCreateChild: () => void;
  openDelete: () => void;
}) {
  if (isMain) {
    return (
      <Button
        aria-label={`New worktree from ${label}`}
        className="ml-1 h-6 px-1.5 text-xs"
        size="xs"
        variant="secondary"
        onClick={handleCreateChild}
      >
        <GitBranchPlus />
        New
      </Button>
    );
  }
  return (
    <>
      <Button
        aria-label={`Create child worktree from ${label}`}
        className="opacity-0 group-hover:opacity-100"
        size="icon-xs"
        variant="ghost"
        onClick={handleCreateChild}
      >
        <GitBranchPlus />
      </Button>
      <Button
        aria-label={`Delete worktree ${label}`}
        className="opacity-0 group-hover:opacity-100"
        size="icon-xs"
        variant="ghost"
        onClick={openDelete}
      >
        <Trash2 className="text-destructive" />
      </Button>
    </>
  );
}

/** The row's visible label: expand caret, branch icon, name/rename input, actions. */
const WorktreeRowLabel = forwardRef<HTMLDivElement, WorktreeRowLabelProps>(
  function WorktreeRowLabel(
    {
      depth,
      expanded,
      hasChildren,
      isMain,
      label,
      merged,
      WorktreeIcon,
      agentStatus,
      rename,
      startRename,
      toggleExpanded,
      handleSelect,
      handleCreateChild,
      openDelete,
      selected,
      className,
      style,
      ...props
    },
    ref,
  ) {
    return (
      <div
        ref={ref}
        className={cn(
          "group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm",
          worktreeRowClass(selected),
          className,
        )}
        style={{ ...style, paddingLeft: 8 + depth * 14 }}
        {...props}
      >
        <WorktreeExpandCaret
          expanded={expanded}
          hasChildren={hasChildren}
          label={label}
          toggleExpanded={toggleExpanded}
        />
        <WorktreeRowPrimaryButton
          agentStatus={agentStatus}
          handleSelect={handleSelect}
          isMain={isMain}
          label={label}
          merged={merged}
          rename={rename}
          startRename={startRename}
          WorktreeIcon={WorktreeIcon}
        />
        <WorktreeRowActions
          handleCreateChild={handleCreateChild}
          isMain={isMain}
          label={label}
          openDelete={openDelete}
        />
      </div>
    );
  },
);

/** The row's right-click menu: rename, copy path/branch, open in editor, hide, delete. */
function WorktreeContextMenu({
  isMain,
  worktree,
  startRename,
  openDelete,
}: {
  isMain: boolean;
  worktree: Worktree;
  startRename: () => void;
  openDelete: () => void;
}) {
  const workspace = useWorkspace();
  const copyPath = useCallback(
    () => void copyToClipboard(worktree.path, "Copied worktree path"),
    [worktree.path],
  );
  const copyBranch = useCallback(
    () => void copyToClipboard(worktree.branch, "Copied branch name"),
    [worktree.branch],
  );
  const hide = useCallback(
    () => void workspace.hideWorktree(worktree.id, true),
    [workspace, worktree.id],
  );
  const openEditor = useCallback(
    (editorId: string) => void workspace.openWorktreeInEditor(worktree.id, editorId),
    [workspace, worktree.id],
  );
  return (
    <ContextMenuContent>
      <ContextMenuItem disabled={isMain} onSelect={isMain ? undefined : startRename}>
        <Pencil />
        Rename
      </ContextMenuItem>
      <ContextMenuItem onSelect={copyPath}>
        <Copy />
        Copy worktree path
      </ContextMenuItem>
      <ContextMenuItem onSelect={copyBranch}>
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
            <ContextMenuItem key={editor.id} onSelect={() => openEditor(editor.id)}>
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
      <ContextMenuItem onSelect={hide}>
        <EyeOff />
        Hide
      </ContextMenuItem>
      {isMain ? null : (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={openDelete}>
            <Trash2 />
            Delete
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}

function WorktreeRow({
  node,
  depth,
  onCreateChild,
  mergedByWorktreeId,
}: {
  node: WorktreeNode;
  depth: number;
  onCreateChild: () => void;
  mergedByWorktreeId: Record<string, boolean>;
}) {
  const workspace = useWorkspace();
  const kanban = useKanban();
  const rename = useWorktreeRename(node.worktree);
  const [expanded, setExpanded] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const selected = workspace.selectedWorktreeId === node.worktree.id;
  const label = worktreeLabel(node.worktree);
  const hasChildren = node.children.length > 0;
  const isMain = node.worktree.isMain;
  const merged = mergedByWorktreeId[node.worktree.id] === true;
  const WorktreeIcon = merged ? GitMerge : GitBranch;
  const agentStatus = useWorktreeAgentStatus(node.worktree.id);

  const handleSelect = useCallback(() => {
    workspace.selectWorktree(node.worktree.id);
    // Selecting a worktree always returns to the terminal view, even when the
    // prompt board is the visible surface.
    kanban.exitBoard();
  }, [workspace, kanban, node.worktree.id]);
  const handleCreateChild = useCallback(() => {
    workspace.selectWorktree(node.worktree.id);
    onCreateChild();
  }, [workspace, node.worktree.id, onCreateChild]);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const openDelete = useCallback(() => setDeleteOpen(true), []);

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <WorktreeRowLabel
            agentStatus={agentStatus}
            depth={depth}
            expanded={expanded}
            handleCreateChild={handleCreateChild}
            handleSelect={handleSelect}
            hasChildren={hasChildren}
            isMain={isMain}
            label={label}
            merged={merged}
            openDelete={openDelete}
            rename={rename}
            selected={selected}
            startRename={rename.startRename}
            toggleExpanded={toggleExpanded}
            WorktreeIcon={WorktreeIcon}
          />
        </ContextMenuTrigger>
        <WorktreeContextMenu
          isMain={isMain}
          openDelete={openDelete}
          startRename={rename.startRename}
          worktree={node.worktree}
        />
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
            mergedByWorktreeId={mergedByWorktreeId}
          />
        ))}
    </div>
  );
}

function HiddenWorktreeRow({
  worktree,
  merged,
  onUnhide,
}: {
  worktree: Worktree;
  merged: boolean;
  onUnhide: () => void;
}) {
  const label = worktree.title ?? worktree.branch;
  const WorktreeIcon = merged ? GitMerge : GitBranch;
  return (
    <div className="mt-1 flex items-center justify-between rounded-md px-2 py-1 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-1.5">
        <WorktreeIcon className={cn("size-3 shrink-0", merged && "text-success")} />
        <span className="truncate">{label}</span>
      </div>
      <Button aria-label={`Show ${label}`} size="icon-xs" variant="ghost" onClick={onUnhide}>
        <EyeOff />
      </Button>
    </div>
  );
}
