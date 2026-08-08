import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type DragEvent,
  type MouseEvent,
} from "react";
import { errorMessage } from "@/lib/errors";

import type { DirEntry } from "@pragma/constants";
import { Icon } from "@iconify/react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { NewEntryInput } from "@/components/right-sidebar/NewEntryInput";
import { RenameEntryInput } from "@/components/right-sidebar/RenameEntryInput";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { beginPathDrag, endPathDrag, isPathDragActive, readDraggedPaths } from "@/lib/file-drag";
import { fileIconId, folderIconId } from "@/lib/file-icons";
import { useSuppressNativeOverlayWhile } from "@/lib/native-overlay";
import { dirname } from "@/lib/path";
import { listDirEntries } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const INDENT_PX = 12;

/** A row only becomes a drop target if dragenter is cancelled too, not just dragover. */
function acceptDragEnter(event: DragEvent<HTMLElement>): void {
  event.preventDefault();
}

/** How long a drag must hover a collapsed folder before it spring-opens. */
export const SPRING_LOAD_MS = 3000;

/** Shared state + actions threaded through the recursive file tree. */
export interface FileTreeController {
  worktreeId: string;
  selectedPaths: Set<string>;
  selectEntry: (entry: DirEntry, event: MouseEvent<HTMLButtonElement>) => void;
  isExpanded: (path: string) => boolean;
  toggleExpand: (path: string) => void;
  expand: (path: string) => void;
  createMode: { dirPath: string; kind: "file" | "folder" } | null;
  beginCreate: (dirPath: string, kind: "file" | "folder") => void;
  cancelCreate: () => void;
  commitCreate: (dirPath: string, kind: "file" | "folder", name: string) => void;
  renameMode: { path: string; kind: "file" | "folder"; name: string } | null;
  beginRename: (path: string, kind: "file" | "folder", name: string) => void;
  cancelRename: () => void;
  commitRename: (path: string, kind: "file" | "folder", name: string) => void;
  commitDelete: (path: string, name: string) => void;
  moveEntries: (paths: string[], targetDir: string) => void;
  dropFiles: (files: File[], targetDir: string) => void;
  nonceFor: (path: string) => number;
  openFile: (path: string) => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; entries: DirEntry[] }
  | { kind: "error"; message: string };

const directoryCache = new Map<string, DirEntry[]>();

function cacheKey(worktreeId: string, path: string): string {
  return `${worktreeId}:${path}`;
}

/** Lazily lists one directory's entries and renders its rows (and create input). */
export function FileTree({
  path,
  depth,
  ctrl,
}: {
  path: string;
  depth: number;
  ctrl: FileTreeController;
}) {
  const cached = directoryCache.get(cacheKey(ctrl.worktreeId, path));
  const [state, setState] = useState<LoadState>(() =>
    cached ? { kind: "ready", entries: cached } : { kind: "loading" },
  );
  const nonce = ctrl.nonceFor(path);

  useEffect(() => {
    let cancelled = false;
    const cachedEntries = directoryCache.get(cacheKey(ctrl.worktreeId, path));
    setState(cachedEntries ? { kind: "ready", entries: cachedEntries } : { kind: "loading" });
    void (async () => {
      try {
        const entries = await listDirEntries(ctrl.worktreeId, path);
        directoryCache.set(cacheKey(ctrl.worktreeId, path), entries);
        if (!cancelled) {
          setState({ kind: "ready", entries });
        }
      } catch (cause) {
        if (!cancelled) {
          setState({ kind: "error", message: errorMessage(cause) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctrl.worktreeId, path, nonce]);

  const creatingHere = ctrl.createMode?.dirPath === path;
  const siblings = state.kind === "ready" ? state.entries.map((entry) => entry.name) : [];

  if (state.kind === "loading") {
    return <Hint depth={depth}>Loading…</Hint>;
  }
  if (state.kind === "error") {
    return <Hint depth={depth}>{state.message}</Hint>;
  }

  return (
    <>
      {creatingHere ? (
        <NewEntryInput
          depth={depth}
          kind={ctrl.createMode!.kind}
          onCancel={ctrl.cancelCreate}
          onCommit={(name) => ctrl.commitCreate(path, ctrl.createMode!.kind, name)}
          siblings={siblings}
        />
      ) : null}
      {state.entries.length === 0 && !creatingHere ? (
        <Hint depth={depth}>Empty</Hint>
      ) : (
        state.entries.map((entry) => (
          <FileTreeNode
            ctrl={ctrl}
            depth={depth}
            entry={entry}
            key={entry.path}
            siblings={siblings}
          />
        ))
      )}
    </>
  );
}

/** A single tree row: a directory (expandable) or a file (opens on double-click). */
export function FileTreeNode({
  entry,
  depth,
  siblings,
  ctrl,
}: {
  entry: DirEntry;
  depth: number;
  siblings: string[];
  ctrl: FileTreeController;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  useSuppressNativeOverlayWhile(menuOpen);

  const expanded = entry.isDir && ctrl.isExpanded(entry.path);
  const renaming = ctrl.renameMode?.path === entry.path;
  const renameKind: "file" | "folder" = entry.isDir ? "folder" : "file";

  if (renaming) {
    return (
      <RenameEntryInput
        depth={depth}
        initialName={entry.name}
        kind={renameKind}
        onCancel={ctrl.cancelRename}
        onCommit={(name) => ctrl.commitRename(entry.path, renameKind, name)}
        siblings={siblings}
      />
    );
  }

  return (
    <>
      <ContextMenu onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>
          <FileTreeNodeTrigger ctrl={ctrl} depth={depth} entry={entry} expanded={expanded} />
        </ContextMenuTrigger>
        <FileTreeNodeContextMenu ctrl={ctrl} entry={entry} renameKind={renameKind} />
      </ContextMenu>
      {expanded ? <FileTree ctrl={ctrl} depth={depth + 1} path={entry.path} /> : null}
    </>
  );
}

/** Row click: selects entries; directories also toggle expansion. */
function handleRowClick(
  ctrl: FileTreeController,
  entry: DirEntry,
  event: MouseEvent<HTMLButtonElement>,
): void {
  ctrl.selectEntry(entry, event);
  if (entry.isDir) {
    ctrl.toggleExpand(entry.path);
  }
}

/** Row double-click: open files (directories do nothing). */
function handleRowDoubleClick(ctrl: FileTreeController, entry: DirEntry): void {
  if (!entry.isDir) {
    ctrl.openFile(entry.path);
  }
}

/** Expand a target directory and start a create (file or folder) inside it. */
function beginCreateIn(ctrl: FileTreeController, targetDir: string, kind: "file" | "folder"): void {
  ctrl.expand(targetDir);
  ctrl.beginCreate(targetDir, kind);
}

/** The expand/collapse chevron for a directory, or a blank spacer for a file. */
function FileTreeRowChevron({ entry, expanded }: { entry: DirEntry; expanded: boolean }) {
  if (!entry.isDir) {
    return <span className="size-3.5 shrink-0 pointer-events-none" />;
  }
  return expanded ? (
    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground pointer-events-none" />
  ) : (
    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground pointer-events-none" />
  );
}

/** The clickable row: chevron, file/folder icon, and name. */
const FileTreeRowButton = forwardRef<
  HTMLButtonElement,
  {
    ctrl: FileTreeController;
    depth: number;
    entry: DirEntry;
    expanded: boolean;
  } & ComponentPropsWithoutRef<"button">
>(function FileTreeRowButton({ ctrl, depth, entry, expanded, ...props }, ref) {
  const selected = ctrl.selectedPaths.has(entry.path);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { className, style, ...buttonProps } = props;

  function cancelSpringLoad() {
    if (springTimer.current === null) return;
    clearTimeout(springTimer.current);
    springTimer.current = null;
  }

  // Never leave a pending spring-open behind when the row unmounts mid-drag.
  useEffect(() => cancelSpringLoad, []);

  function endDrag() {
    cancelSpringLoad();
    setIsDropTarget(false);
  }
  function onDragEnd() {
    endDrag();
    endPathDrag();
  }
  function onDragStart(event: DragEvent<HTMLButtonElement>) {
    beginPathDrag(
      event,
      ctrl.selectedPaths.has(entry.path) ? [...ctrl.selectedPaths] : [entry.path],
    );
  }
  function onDragOver(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = isPathDragActive() ? "move" : "copy";
    setIsDropTarget(true);
    // Hovering a collapsed folder long enough opens it, so a drag can reach nested folders.
    if (!entry.isDir || expanded || springTimer.current !== null) return;
    springTimer.current = setTimeout(() => {
      springTimer.current = null;
      ctrl.expand(entry.path);
    }, SPRING_LOAD_MS);
  }
  // dragleave also fires when the cursor crosses onto the row's own icon/label, which
  // would restart the spring-load timer forever. Only a leave of the whole row counts.
  function onDragLeave(event: DragEvent<HTMLButtonElement>) {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    endDrag();
  }
  // Dropping on a file targets the folder that holds it, so no row is a dead zone.
  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    endDrag();
    const targetDir = entry.isDir ? entry.path : dirname(entry.path);
    const paths = readDraggedPaths(event);
    if (paths) {
      ctrl.moveEntries(paths, targetDir);
    } else if (event.dataTransfer.files.length > 0) {
      ctrl.dropFiles([...event.dataTransfer.files], targetDir);
    }
    endPathDrag();
  }
  return (
    <button
      ref={ref}
      className={cn(
        "flex h-6 w-full select-none items-center gap-1 px-2 text-left text-xs hover:bg-muted",
        selected ? "bg-muted outline outline-1 -outline-offset-1 outline-primary/60" : null,
        isDropTarget ? "bg-primary/20 outline outline-1 -outline-offset-1 outline-primary" : null,
        className,
      )}
      data-file-tree-path={entry.path}
      draggable
      onClick={(event) => handleRowClick(ctrl, entry, event)}
      onDoubleClick={() => handleRowDoubleClick(ctrl, entry)}
      onDragEnd={onDragEnd}
      onDragEnter={acceptDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDragStart={onDragStart}
      onDrop={onDrop}
      style={{ ...style, paddingLeft: depth * INDENT_PX + 8 }}
      type="button"
      {...buttonProps}
    >
      <FileTreeRowChevron entry={entry} expanded={expanded} />
      <Icon
        className="size-4 shrink-0 pointer-events-none"
        icon={entry.isDir ? folderIconId(expanded) : fileIconId(entry.name)}
      />
      <span className="min-w-0 flex-1 truncate text-foreground pointer-events-none">
        {entry.name}
      </span>
    </button>
  );
});

/** The context-menu trigger row. It forwards Radix's injected right-click handlers. */
const FileTreeNodeTrigger = forwardRef<
  HTMLButtonElement,
  {
    ctrl: FileTreeController;
    depth: number;
    entry: DirEntry;
    expanded: boolean;
  } & ComponentPropsWithoutRef<"button">
>(function FileTreeNodeTrigger({ ctrl, depth, entry, expanded, ...props }, ref) {
  return (
    <FileTreeRowButton
      ref={ref}
      ctrl={ctrl}
      depth={depth}
      entry={entry}
      expanded={expanded}
      {...props}
    />
  );
});

/** Right-click actions: new file/folder, rename, delete. */
function FileTreeNodeContextMenu({
  ctrl,
  entry,
  renameKind,
}: {
  ctrl: FileTreeController;
  entry: DirEntry;
  renameKind: "file" | "folder";
}) {
  const targetDir = entry.isDir ? entry.path : dirname(entry.path);
  return (
    <ContextMenuContent>
      <ContextMenuItem onSelect={() => beginCreateIn(ctrl, targetDir, "file")}>
        New File
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => beginCreateIn(ctrl, targetDir, "folder")}>
        New Folder
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => ctrl.beginRename(entry.path, renameKind, entry.name)}>
        Rename
      </ContextMenuItem>
      <ContextMenuItem
        className="text-destructive focus:text-destructive"
        onSelect={() => ctrl.commitDelete(entry.path, entry.name)}
      >
        Delete
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

function Hint({ depth, children }: { depth: number; children: React.ReactNode }) {
  return (
    <div
      className="px-2 py-0.5 text-xs text-muted-foreground"
      style={{ paddingLeft: depth * INDENT_PX + 8 }}
    >
      {children}
    </div>
  );
}
