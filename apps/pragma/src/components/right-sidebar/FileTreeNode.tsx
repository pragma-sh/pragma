import { useEffect, useState } from "react";

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
import { fileIconId, folderIconId } from "@/lib/file-icons";
import { useSuppressNativeOverlayWhile } from "@/lib/native-overlay";
import { dirname } from "@/lib/path";
import { listDirEntries } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const INDENT_PX = 12;

/** Shared state + actions threaded through the recursive file tree. */
export interface FileTreeController {
  worktreeId: string;
  selectedDir: string;
  selectDir: (path: string) => void;
  selectedFile: string;
  selectFile: (path: string) => void;
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
  nonceFor: (path: string) => number;
  openFile: (path: string) => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; entries: DirEntry[] }
  | { kind: "error"; message: string };

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const nonce = ctrl.nonceFor(path);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const entries = await listDirEntries(ctrl.worktreeId, path);
        if (!cancelled) {
          setState({ kind: "ready", entries });
        }
      } catch (cause) {
        if (!cancelled) {
          setState({ kind: "error", message: messageFor(cause) });
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
  const selected = ctrl.selectedDir === entry.path;
  const fileSelected = !entry.isDir && ctrl.selectedFile === entry.path;
  const targetDir = entry.isDir ? entry.path : dirname(entry.path);
  const renaming = ctrl.renameMode?.path === entry.path;
  const renameKind: "file" | "folder" = entry.isDir ? "folder" : "file";

  return (
    <>
      <ContextMenu onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>
          {renaming ? (
            <RenameEntryInput
              depth={depth}
              initialName={entry.name}
              kind={renameKind}
              onCancel={ctrl.cancelRename}
              onCommit={(name) => ctrl.commitRename(entry.path, renameKind, name)}
              siblings={siblings}
            />
          ) : (
            <button
              className={cn(
                "flex h-6 w-full items-center gap-1 px-2 text-left text-xs hover:bg-white/5",
                selected ? "bg-white/10" : null,
                fileSelected ? "outline outline-1 -outline-offset-1 outline-cyan-400/60" : null,
              )}
              onClick={() => {
                if (entry.isDir) {
                  ctrl.selectDir(entry.path);
                  ctrl.toggleExpand(entry.path);
                } else {
                  ctrl.selectFile(entry.path);
                }
              }}
              onDoubleClick={() => {
                if (!entry.isDir) {
                  ctrl.openFile(entry.path);
                }
              }}
              style={{ paddingLeft: depth * INDENT_PX + 8 }}
              type="button"
            >
              {entry.isDir ? (
                expanded ? (
                  <ChevronDown className="size-3.5 shrink-0 text-slate-500" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-slate-500" />
                )
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              <Icon
                className="size-4 shrink-0"
                icon={entry.isDir ? folderIconId(expanded) : fileIconId(entry.name)}
              />
              <span className="min-w-0 flex-1 truncate text-slate-200">{entry.name}</span>
            </button>
          )}
        </ContextMenuTrigger>
        {!renaming ? (
          <ContextMenuContent>
            <ContextMenuItem
              onSelect={() => {
                ctrl.expand(targetDir);
                ctrl.beginCreate(targetDir, "file");
              }}
            >
              New File
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                ctrl.expand(targetDir);
                ctrl.beginCreate(targetDir, "folder");
              }}
            >
              New Folder
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                ctrl.beginRename(entry.path, renameKind, entry.name);
              }}
            >
              Rename
            </ContextMenuItem>
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => {
                ctrl.commitDelete(entry.path, entry.name);
              }}
            >
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        ) : null}
      </ContextMenu>
      {expanded && !renaming ? <FileTree ctrl={ctrl} depth={depth + 1} path={entry.path} /> : null}
    </>
  );
}

function Hint({ depth, children }: { depth: number; children: React.ReactNode }) {
  return (
    <div
      className="px-2 py-0.5 text-xs text-slate-600"
      style={{ paddingLeft: depth * INDENT_PX + 8 }}
    >
      {children}
    </div>
  );
}
