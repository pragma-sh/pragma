import { useCallback, useEffect, useMemo, useState } from "react";

import { FilePlus, FolderPlus } from "lucide-react";
import { toast } from "sonner";

import { FileTree, type FileTreeController } from "@/components/right-sidebar/FileTreeNode";
import { Button } from "@/components/ui/button";
import { useWorktreeFileChange } from "@/lib/file-watch";
import { basename, dirname, joinPath } from "@/lib/path";
import { createFile, createFolder, deleteFile, renameFile } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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

  const [selectedDir, setSelectedDir] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [nonces, setNonces] = useState<Record<string, number>>({});
  const [createMode, setCreateMode] = useState<{ dirPath: string; kind: "file" | "folder" } | null>(
    null,
  );
  const [renameMode, setRenameMode] = useState<{
    path: string;
    kind: "file" | "folder";
    name: string;
  } | null>(null);

  // Reset all tree state when the worktree changes.
  useEffect(() => {
    setSelectedDir("");
    setSelectedFile("");
    setExpanded(new Set());
    setNonces({});
    setCreateMode(null);
    setRenameMode(null);
  }, [worktreeId]);

  const bumpNonce = useCallback((path: string) => {
    setNonces((previous) => ({ ...previous, [path]: (previous[path] ?? 0) + 1 }));
  }, []);

  // Reflect external filesystem changes (e.g. a file created from the terminal
  // or by an agent) by refreshing the directory that contains each change. Our
  // own create/delete/rename actions already bump the relevant nonce, so the
  // duplicate watcher event is a cheap, idempotent re-list.
  useWorktreeFileChange(worktreeId ?? "", (change) => {
    bumpNonce(dirname(change.path));
  });

  /**
   * Deletes a file (or empty directory) immediately. Git tracks the worktree so
   * recovery is just `git checkout -- <path>` / `git clean -fd` away — no
   * confirmation dialog.
   */
  const commitDelete = useCallback(
    async (path: string, name: string) => {
      if (!worktreeId) {
        return;
      }
      try {
        await deleteFile(worktreeId, path);
        if (selectedFile === path) {
          setSelectedFile("");
        }
        bumpNonce(dirname(path));
        toast.success(`Deleted ${name}`);
      } catch (cause) {
        toast.error(messageFor(cause));
      }
    },
    [worktreeId, bumpNonce, selectedFile],
  );

  // Wire the global Cmd/Ctrl+Delete shortcut dispatched by `WorkspaceShell`. The
  // shortcut only acts if a file is currently selected — a no-op when the user
  // is focused elsewhere in the app.
  useEffect(() => {
    function onRequest() {
      if (selectedFile) {
        void commitDelete(selectedFile, basename(selectedFile));
      }
    }
    window.addEventListener("pragma:request-delete-file", onRequest);
    return () => window.removeEventListener("pragma:request-delete-file", onRequest);
  }, [selectedFile, commitDelete]);

  const ctrl = useMemo<FileTreeController>(
    () => ({
      worktreeId: worktreeId ?? "",
      selectedDir,
      selectDir: setSelectedDir,
      selectedFile,
      selectFile: setSelectedFile,
      isExpanded: (path) => expanded.has(path),
      toggleExpand: (path) =>
        setExpanded((previous) => {
          const next = new Set(previous);
          if (next.has(path)) {
            next.delete(path);
          } else {
            next.add(path);
          }
          return next;
        }),
      expand: (path) =>
        setExpanded((previous) => (previous.has(path) ? previous : new Set(previous).add(path))),
      createMode,
      beginCreate: (dirPath, kind) => setCreateMode({ dirPath, kind }),
      cancelCreate: () => setCreateMode(null),
      commitCreate: (dirPath, kind, name) => {
        if (!worktreeId) {
          return;
        }
        const path = joinPath(dirPath, name);
        const create = kind === "file" ? createFile : createFolder;
        void (async () => {
          try {
            await create(worktreeId, path);
            setCreateMode(null);
            bumpNonce(dirPath);
            if (kind === "file") {
              void workspace.openFileTab(path);
            }
          } catch (cause) {
            toast.error(messageFor(cause));
          }
        })();
      },
      renameMode,
      beginRename: (path, kind, name) => setRenameMode({ path, kind, name }),
      cancelRename: () => setRenameMode(null),
      commitRename: (path, _kind, name) => {
        if (!worktreeId) {
          return;
        }
        const fromParent = dirname(path);
        const toPath = joinPath(fromParent, name);
        if (toPath === path) {
          setRenameMode(null);
          return;
        }
        void (async () => {
          try {
            await renameFile(worktreeId, path, toPath);
            setRenameMode(null);
            bumpNonce(fromParent);
            const toParent = dirname(toPath);
            if (toParent !== fromParent) {
              // Cross-directory rename: refresh the destination parent too.
              bumpNonce(toParent);
            }
          } catch (cause) {
            toast.error(messageFor(cause));
          }
        })();
      },
      commitDelete,
      nonceFor: (path) => nonces[path] ?? 0,
      openFile: (path) => void workspace.openFileTab(path),
    }),
    [
      worktreeId,
      selectedDir,
      selectedFile,
      expanded,
      createMode,
      renameMode,
      nonces,
      bumpNonce,
      commitDelete,
      workspace,
    ],
  );

  if (!worktreeId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-slate-500">
        Select a worktree to browse its files.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-1 border-b border-white/10 px-2 py-1">
        <span className="min-w-0 truncate text-[11px] uppercase tracking-wide text-slate-500">
          {selectedDir ? `selected: ${selectedDir}/` : "selected: /"}
        </span>
        <div className="flex shrink-0 gap-0.5">
          <Button
            aria-label="New File"
            className="text-slate-300 hover:bg-white/10 hover:text-white"
            onClick={() => {
              ctrl.expand(selectedDir);
              ctrl.beginCreate(selectedDir, "file");
            }}
            size="icon-sm"
            variant="ghost"
          >
            <FilePlus />
          </Button>
          <Button
            aria-label="New Folder"
            className="text-slate-300 hover:bg-white/10 hover:text-white"
            onClick={() => {
              ctrl.expand(selectedDir);
              ctrl.beginCreate(selectedDir, "folder");
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
