import { useCallback, useEffect, useMemo, useState } from "react";

import { FilePlus, FolderPlus } from "lucide-react";
import { toast } from "sonner";

import { FileTree, type FileTreeController } from "@/components/right-sidebar/FileTreeNode";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { useWorktreeFileChange } from "@/lib/file-watch";
import { basename, dirname, joinPath } from "@/lib/path";
import { createFile, createFolder, deleteFile, renameFile } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

type CreateMode = { dirPath: string; kind: "file" | "folder" } | null;
type RenameMode = { path: string; kind: "file" | "folder"; name: string } | null;
type Workspace = ReturnType<typeof useWorkspace>;

/** Toggle a path's membership in the expanded set (returns a new set). */
function toggleExpanded(previous: Set<string>, path: string): Set<string> {
  const next = new Set(previous);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  return next;
}

/** Ensure a path is in the expanded set (returns the same set if already present). */
function withExpanded(previous: Set<string>, path: string): Set<string> {
  return previous.has(path) ? previous : new Set(previous).add(path);
}

interface CreateContext {
  worktreeId: string;
  dirPath: string;
  kind: "file" | "folder";
  name: string;
  workspace: Workspace;
  bumpNonce: (path: string) => void;
  setCreateMode: (mode: CreateMode) => void;
}

/** Create a file or folder, refresh the parent, and open new files. */
async function runCommitCreate(ctx: CreateContext): Promise<void> {
  if (!ctx.worktreeId) return;
  const path = joinPath(ctx.dirPath, ctx.name);
  const create = ctx.kind === "file" ? createFile : createFolder;
  try {
    await create(ctx.worktreeId, path);
    ctx.setCreateMode(null);
    ctx.bumpNonce(ctx.dirPath);
    if (ctx.kind === "file") void ctx.workspace.openFileTab(path);
  } catch (cause) {
    toast.error(errorMessage(cause));
  }
}

interface RenameContext {
  worktreeId: string;
  path: string;
  name: string;
  bumpNonce: (path: string) => void;
  setRenameMode: (mode: RenameMode) => void;
}

/** Rename a file/folder, refreshing the source (and destination) parent dirs. */
async function runCommitRename(ctx: RenameContext): Promise<void> {
  if (!ctx.worktreeId) return;
  const fromParent = dirname(ctx.path);
  const toPath = joinPath(fromParent, ctx.name);
  if (toPath === ctx.path) {
    ctx.setRenameMode(null);
    return;
  }
  try {
    await renameFile(ctx.worktreeId, ctx.path, toPath);
    ctx.setRenameMode(null);
    ctx.bumpNonce(fromParent);
    const toParent = dirname(toPath);
    // Cross-directory rename: refresh the destination parent too.
    if (toParent !== fromParent) ctx.bumpNonce(toParent);
  } catch (cause) {
    toast.error(errorMessage(cause));
  }
}

/** Owns the file-tree's selection, expansion, per-directory refresh nonces, and inline create/rename mode. */
function useFileTreeState(worktreeId: string | null) {
  const [selectedDir, setSelectedDir] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [nonces, setNonces] = useState<Record<string, number>>({});
  const [createMode, setCreateMode] = useState<CreateMode>(null);
  const [renameMode, setRenameMode] = useState<RenameMode>(null);

  // Reset all tree state when the worktree changes.
  useEffect(() => {
    setSelectedDir("");
    setSelectedFile("");
    setExpanded(new Set());
    setNonces({});
    setCreateMode(null);
    setRenameMode(null);
  }, [worktreeId]);

  const bumpNonce = useCallback(
    (path: string) => setNonces((previous) => ({ ...previous, [path]: (previous[path] ?? 0) + 1 })),
    [],
  );

  // Reflect external filesystem changes by refreshing the directory that contains each change.
  useWorktreeFileChange(worktreeId ?? "", (change) => bumpNonce(dirname(change.path)));

  return {
    selectedDir,
    setSelectedDir,
    selectedFile,
    setSelectedFile,
    expanded,
    setExpanded,
    nonces,
    createMode,
    setCreateMode,
    renameMode,
    setRenameMode,
    bumpNonce,
  };
}

/** Delete handler + the global Cmd/Ctrl+Delete shortcut wiring. */
function useFileTreeDelete(
  worktreeId: string | null,
  selectedFile: string,
  setSelectedFile: (value: string) => void,
  bumpNonce: (path: string) => void,
): (path: string, name: string) => Promise<void> {
  const commitDelete = useCallback(
    async (path: string, name: string) => {
      if (!worktreeId) return;
      // Git tracks the worktree so recovery is `git checkout -- <path>` / `git clean -fd` — no confirm dialog.
      try {
        await deleteFile(worktreeId, path);
        if (selectedFile === path) setSelectedFile("");
        bumpNonce(dirname(path));
        toast.success(`Deleted ${name}`);
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    },
    [worktreeId, bumpNonce, selectedFile, setSelectedFile],
  );

  useEffect(() => {
    function onRequest() {
      if (selectedFile) void commitDelete(selectedFile, basename(selectedFile));
    }
    window.addEventListener("pragma:request-delete-file", onRequest);
    return () => window.removeEventListener("pragma:request-delete-file", onRequest);
  }, [selectedFile, commitDelete]);

  return commitDelete;
}

/** Build the {@link FileTreeController} from current state and helpers. */
function buildFileTreeController(args: {
  worktreeId: string;
  workspace: Workspace;
  state: ReturnType<typeof useFileTreeState>;
  commitDelete: (path: string, name: string) => Promise<void>;
}): FileTreeController {
  const { worktreeId, workspace, state, commitDelete } = args;
  return {
    worktreeId,
    selectedDir: state.selectedDir,
    selectDir: state.setSelectedDir,
    selectedFile: state.selectedFile,
    selectFile: state.setSelectedFile,
    isExpanded: (path) => state.expanded.has(path),
    toggleExpand: (path) => state.setExpanded((previous) => toggleExpanded(previous, path)),
    expand: (path) => state.setExpanded((previous) => withExpanded(previous, path)),
    createMode: state.createMode,
    beginCreate: (dirPath, kind) => state.setCreateMode({ dirPath, kind }),
    cancelCreate: () => state.setCreateMode(null),
    commitCreate: (dirPath, kind, name) =>
      void runCommitCreate({
        worktreeId,
        dirPath,
        kind,
        name,
        workspace,
        bumpNonce: state.bumpNonce,
        setCreateMode: state.setCreateMode,
      }),
    renameMode: state.renameMode,
    beginRename: (path, kind, name) => state.setRenameMode({ path, kind, name }),
    cancelRename: () => state.setRenameMode(null),
    commitRename: (path, _kind, name) =>
      void runCommitRename({
        worktreeId,
        path,
        name,
        bumpNonce: state.bumpNonce,
        setRenameMode: state.setRenameMode,
      }),
    commitDelete,
    nonceFor: (path) => state.nonces[path] ?? 0,
    openFile: (path) => void workspace.openFileTab(path),
  };
}

/**
 * The Files subtab: a lazy VS Code–style tree plus New File / New Folder. Owns
 * the selected directory, the selected file (for delete/rename focus), the
 * expanded set, per-directory refresh nonces, and the inline create / rename
 * state machines, threading them to the recursive tree through a
 * {@link FileTreeController}.
 */
export function FilesTab() {
  const workspace = useWorkspace();
  const worktreeId = workspace.selectedWorktreeId;
  const state = useFileTreeState(worktreeId ?? null);
  const commitDelete = useFileTreeDelete(
    worktreeId ?? null,
    state.selectedFile,
    state.setSelectedFile,
    state.bumpNonce,
  );
  const wtId = worktreeId ?? "";
  const ctrl = useMemo(
    () => buildFileTreeController({ worktreeId: wtId, workspace, state, commitDelete }),
    [wtId, workspace, state, commitDelete],
  );

  if (!worktreeId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        Select a worktree to browse its files.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-1 border-b border-border px-2 py-1">
        <span className="min-w-0 truncate text-[11px] uppercase tracking-wide text-muted-foreground">
          {state.selectedDir ? `selected: ${state.selectedDir}/` : "selected: /"}
        </span>
        <div className="flex shrink-0 gap-0.5">
          <Button
            aria-label="New File"
            className="text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => {
              ctrl.expand(state.selectedDir);
              ctrl.beginCreate(state.selectedDir, "file");
            }}
            size="icon-sm"
            variant="ghost"
          >
            <FilePlus />
          </Button>
          <Button
            aria-label="New Folder"
            className="text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => {
              ctrl.expand(state.selectedDir);
              ctrl.beginCreate(state.selectedDir, "folder");
            }}
            size="icon-sm"
            variant="ghost"
          >
            <FolderPlus />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        <FileTree ctrl={ctrl} depth={0} path="" />
      </div>
    </div>
  );
}
