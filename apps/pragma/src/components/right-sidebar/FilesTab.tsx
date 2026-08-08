import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { FilePlus, FolderPlus } from "lucide-react";
import { toast } from "sonner";

import { FileTree, type FileTreeController } from "@/components/right-sidebar/FileTreeNode";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { endPathDrag, isPathDragActive, readDraggedPaths } from "@/lib/file-drag";
import { useWorktreeFileChange } from "@/lib/file-watch";
import { basename, dirname, joinPath } from "@/lib/path";
import {
  createFile,
  createFolder,
  deleteFile,
  pathExists,
  renameFile,
  writeFileBytes,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
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

function rangePaths(
  event: MouseEvent<HTMLButtonElement>,
  anchor: string,
  path: string,
): Set<string> {
  const paths = [
    ...event.currentTarget.ownerDocument.querySelectorAll<HTMLButtonElement>(
      "[data-file-tree-path]",
    ),
  ]
    .map((element) => element.dataset.fileTreePath)
    .filter((value): value is string => value !== undefined);
  const start = paths.indexOf(anchor);
  const end = paths.indexOf(path);
  return start < 0 || end < 0
    ? new Set([path])
    : new Set(paths.slice(Math.min(start, end), Math.max(start, end) + 1));
}

/** True when a click landed on a tree row (or an inline create/rename input) rather than empty space. */
function hitsTreeRow(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-file-tree-path], input") !== null;
}

function isNestedPath(path: string, targetDir: string): boolean {
  return targetDir === path || targetDir.startsWith(`${path}/`);
}

/**
 * The area below the tree (and any gap beside it) drops into the worktree root,
 * which has no row of its own. Drops that land on a row are left to that row.
 */
function useRootDropZone(ctrl: FileTreeController): {
  isDropTarget: boolean;
  handlers: {
    onDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
    onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  };
} {
  const [isDropTarget, setIsDropTarget] = useState(false);

  function accepts(event: React.DragEvent<HTMLDivElement>): boolean {
    return !hitsTreeRow(event.target);
  }
  function onDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!accepts(event)) return;
    event.preventDefault();
  }
  function onDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!accepts(event)) {
      setIsDropTarget(false);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = isPathDragActive() ? "move" : "copy";
    setIsDropTarget(true);
  }
  function onDragLeave(event: React.DragEvent<HTMLDivElement>) {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setIsDropTarget(false);
  }
  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    setIsDropTarget(false);
    if (!accepts(event)) return;
    event.preventDefault();
    const paths = readDraggedPaths(event);
    if (paths) {
      ctrl.moveEntries(paths, "");
    } else if (event.dataTransfer.files.length > 0) {
      ctrl.dropFiles([...event.dataTransfer.files], "");
    }
    endPathDrag();
  }
  return { isDropTarget, handlers: { onDragEnter, onDragLeave, onDragOver, onDrop } };
}

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [selectionAnchor, setSelectionAnchor] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [nonces, setNonces] = useState<Record<string, number>>({});
  const [createMode, setCreateMode] = useState<CreateMode>(null);
  const [renameMode, setRenameMode] = useState<RenameMode>(null);

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
    setSelectionAnchor("");
    setSelectedDir("");
    setSelectedFile("");
  }, []);

  // Reset all tree state when the worktree changes.
  useEffect(() => {
    setSelectedDir("");
    setSelectedFile("");
    setSelectedPaths(new Set());
    setSelectionAnchor("");
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
    selectedPaths,
    setSelectedPaths,
    selectionAnchor,
    setSelectionAnchor,
    expanded,
    setExpanded,
    nonces,
    createMode,
    setCreateMode,
    renameMode,
    setRenameMode,
    bumpNonce,
    clearSelection,
  };
}

/**
 * Clears the tree selection on any primary click that is not on a row: empty space inside
 * the tree, or anywhere outside the Files panel. Clicks on the panel's own header (New
 * File / New Folder) are ignored so they still act on the selected directory.
 */
function useClearSelectionOnClickAway(
  panel: React.RefObject<HTMLDivElement | null>,
  tree: React.RefObject<HTMLDivElement | null>,
  clearSelection: () => void,
): void {
  useEffect(() => {
    function onMouseDown(event: globalThis.MouseEvent) {
      if (event.button !== 0) return;
      const target = event.target;
      if (hitsTreeRow(target)) return;
      const node = target instanceof Node ? target : null;
      const insidePanel = node !== null && panel.current?.contains(node) === true;
      const insideTree = node !== null && tree.current?.contains(node) === true;
      if (insidePanel && !insideTree) return;
      clearSelection();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [panel, tree, clearSelection]);
}

/** Delete handler + the global Cmd/Ctrl+Delete shortcut wiring. */
function useFileTreeDelete(
  worktreeId: string | null,
  selectedPaths: Set<string>,
  setSelectedPaths: React.Dispatch<React.SetStateAction<Set<string>>>,
  bumpNonce: (path: string) => void,
): (path: string, name: string) => Promise<void> {
  const commitDelete = useCallback(
    async (path: string, name: string) => {
      if (!worktreeId) return;
      // Git tracks the worktree so recovery is `git checkout -- <path>` / `git clean -fd` — no confirm dialog.
      try {
        await deleteFile(worktreeId, path);
        setSelectedPaths((previous) => {
          const next = new Set(previous);
          next.delete(path);
          return next;
        });
        bumpNonce(dirname(path));
        toast.success(`Deleted ${name}`);
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    },
    [worktreeId, bumpNonce, setSelectedPaths],
  );

  useEffect(() => {
    function onRequest() {
      for (const path of selectedPaths) void commitDelete(path, basename(path));
    }
    window.addEventListener("pragma:request-delete-file", onRequest);
    return () => window.removeEventListener("pragma:request-delete-file", onRequest);
  }, [selectedPaths, commitDelete]);

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
  function selectEntry(
    entry: import("@pragma/constants").DirEntry,
    event: MouseEvent<HTMLButtonElement>,
  ) {
    const additive = event.metaKey || event.ctrlKey;
    const ranged =
      event.shiftKey && state.selectionAnchor
        ? rangePaths(event, state.selectionAnchor, entry.path)
        : new Set([entry.path]);
    state.setSelectedPaths((previous) => {
      if (event.shiftKey) return additive ? new Set([...previous, ...ranged]) : ranged;
      if (!additive) return new Set([entry.path]);
      const next = new Set(previous);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!event.shiftKey) state.setSelectionAnchor(entry.path);
    if (entry.isDir) state.setSelectedDir(entry.path);
    else state.setSelectedFile(entry.path);
  }
  async function moveEntries(allPaths: string[], targetDir: string) {
    if (allPaths.some((path) => isNestedPath(path, targetDir))) {
      toast.error("Cannot move a folder into itself");
      return;
    }
    // Entries already in the target directory are a no-op, not a name collision.
    const paths = allPaths.filter((path) => dirname(path) !== targetDir);
    if (paths.length === 0) return;
    try {
      const destinations = paths.map((path) => joinPath(targetDir, basename(path)));
      if (
        (await Promise.all(destinations.map((path) => pathExists(worktreeId, path)))).some(Boolean)
      ) {
        toast.error("Destination already contains one of these entries");
        return;
      }
      await Promise.all(
        paths.map((path, index) => renameFile(worktreeId, path, destinations[index]!)),
      );
      for (const path of paths) state.bumpNonce(dirname(path));
      state.bumpNonce(targetDir);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }
  async function dropFiles(files: File[], targetDir: string) {
    if (files.some((file) => file.size > 2 * 1024 * 1024)) {
      toast.error("Dropped files must not exceed 2 MiB");
      return;
    }
    try {
      const destinations = files.map((file) => joinPath(targetDir, file.name));
      if (
        (await Promise.all(destinations.map((path) => pathExists(worktreeId, path)))).some(Boolean)
      ) {
        toast.error("Destination already contains one of these files");
        return;
      }
      await Promise.all(
        files.map(async (file, index) =>
          writeFileBytes(worktreeId, destinations[index]!, await fileBase64(file)),
        ),
      );
      state.bumpNonce(targetDir);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }
  return {
    worktreeId,
    selectedPaths: state.selectedPaths,
    selectEntry,
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
    moveEntries: (paths, targetDir) => void moveEntries(paths, targetDir),
    dropFiles: (files, targetDir) => void dropFiles(files, targetDir),
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
    state.selectedPaths,
    state.setSelectedPaths,
    state.bumpNonce,
  );
  const wtId = worktreeId ?? "";
  const ctrl = useMemo(
    () => buildFileTreeController({ worktreeId: wtId, workspace, state, commitDelete }),
    [wtId, workspace, state, commitDelete],
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  useClearSelectionOnClickAway(panelRef, treeRef, state.clearSelection);
  const rootDrop = useRootDropZone(ctrl);

  if (!worktreeId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        Select a worktree to browse its files.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" ref={panelRef}>
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
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto py-1",
          rootDrop.isDropTarget
            ? "bg-primary/10 outline outline-1 -outline-offset-1 outline-primary"
            : null,
        )}
        data-file-tree-root
        ref={treeRef}
        {...rootDrop.handlers}
      >
        <FileTree ctrl={ctrl} depth={0} path="" />
      </div>
    </div>
  );
}
