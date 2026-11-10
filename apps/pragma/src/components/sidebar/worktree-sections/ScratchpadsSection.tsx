import { useEffect, useMemo } from "react";
import { StickyNote } from "lucide-react";

import { constants, type ScratchpadSummary, type Worktree } from "@pragma-sh/constants";
import type { PluginWorktree } from "@pragma-sh/plugin";

import { subscribeToWorktreeFiles } from "@/lib/file-watch";
import { listScratchpads } from "@/lib/tauri";
import { useKanban } from "@/state/kanban-context";
import { useWorkspace } from "@/state/workspace-context";
import { createWorktreeListStore } from "@/state/worktree-list-store";
import { SectionItem } from "./SectionItem";
import type { BuiltInWorktreeSection } from "./types";
import { useInvalidateOnChange, useWorktreeTabSignature } from "./use-section-refresh";

const scratchpads = createWorktreeListStore<ScratchpadSummary>(listScratchpads);

/** Which live watch reports a worktree's scratchpad files, and under what path. */
interface ScratchpadWatch {
  worktreeId: string;
  prefix: string;
}

/** Forward-slash form of a path, so it compares against watch event paths. */
function slashed(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

/**
 * Standard child checkouts live under the main worktree, whose one recursive
 * watch already sees their files, so rows share it instead of each opening an
 * OS watcher. A checkout elsewhere is watched only while it is selected.
 */
function scratchpadWatch(
  worktree: PluginWorktree,
  main: Worktree | undefined,
): ScratchpadWatch | null {
  const directory = `${constants.scratchpads.directory}/`;
  if (worktree.isMain || !main) return { worktreeId: worktree.id, prefix: directory };
  const root = `${slashed(main.path)}/`;
  const path = slashed(worktree.path);
  if (path.startsWith(root)) {
    return { worktreeId: main.id, prefix: `${path.slice(root.length)}/${directory}` };
  }
  return worktree.selected ? { worktreeId: worktree.id, prefix: directory } : null;
}

/**
 * Keeps a worktree's scratchpad list current. An agent creating, renaming, or
 * deleting a scratchpad file touches no tab, so the watch catches those; tab
 * churn covers checkouts no watch reaches.
 */
function useScratchpadRefresh(worktree: PluginWorktree): void {
  const { worktrees } = useWorkspace();
  const main = worktrees[worktree.projectId]?.find((candidate) => candidate.isMain);
  const watch = useMemo(() => scratchpadWatch(worktree, main), [worktree, main]);
  const watchId = watch?.worktreeId;
  const prefix = watch?.prefix;
  useEffect(() => {
    if (!watchId || !prefix) return;
    return subscribeToWorktreeFiles(watchId, (change) => {
      if (change.path.startsWith(prefix)) scratchpads.invalidate(worktree.id);
    });
  }, [watchId, prefix, worktree.id]);
  const tabs = useWorktreeTabSignature(worktree.id, "scratchpad");
  useInvalidateOnChange(tabs, () => scratchpads.invalidate(worktree.id));
}

function ScratchpadsBody({ worktree }: { worktree: PluginWorktree }) {
  const items = scratchpads.useList(worktree.id) ?? [];
  const kanban = useKanban();
  const workspace = useWorkspace();
  return items.map((scratchpad) => (
    <SectionItem
      key={scratchpad.id}
      onClick={() => {
        // The board replaces the normal shell, where scratchpad tabs render.
        kanban.exitBoard();
        void workspace.openScratchpadFile(scratchpad.filePath, scratchpad.title, worktree.id);
      }}
    >
      <StickyNote className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{scratchpad.title}</span>
    </SectionItem>
  ));
}

/** The worktree's managed scratchpad files; a click opens (or focuses) one. */
export const scratchpadsSection: BuiltInWorktreeSection = {
  id: "scratchpads",
  title: "Scratchpads",
  icon: StickyNote,
  useCount: (worktree) => {
    useScratchpadRefresh(worktree);
    return scratchpads.useList(worktree.id)?.length ?? null;
  },
  Body: ScratchpadsBody,
};
