import { useCallback, useEffect, useRef, useState } from "react";

import { homeDir } from "@tauri-apps/api/path";

import type { MiniProjectCatalog } from "@/components/mini/MiniLocationMenu";
import { listProjects, listWorktrees, onWorktreeChanged } from "@/lib/tauri";

const EMPTY_CATALOG: MiniProjectCatalog = { projects: [], worktrees: {} };

async function loadCatalog(): Promise<MiniProjectCatalog> {
  const projects = await listProjects();
  const lists = await Promise.all(
    projects.map((project) =>
      // An unreachable remote host lists no worktrees rather than hiding every project.
      listWorktrees(project.id).catch(() => []),
    ),
  );
  const worktrees: MiniProjectCatalog["worktrees"] = {};
  projects.forEach((project, index) => {
    worktrees[project.id] = (lists[index] ?? []).filter((worktree) => !worktree.hidden);
  });
  return { projects, worktrees };
}

/** The catalog plus a way to refresh it on demand. */
export interface MiniCatalogState {
  catalog: MiniProjectCatalog;
  reload: () => void;
}

/**
 * Every project and its visible worktrees, for the tab context menu. Reloaded
 * when the window gains focus, when a worktree changes, and whenever a tab's
 * context menu opens (`reload`), so a project or worktree created in the main
 * window shows up without reopening the mini window.
 */
export function useMiniCatalog(): MiniCatalogState {
  const [catalog, setCatalog] = useState(EMPTY_CATALOG);
  const mounted = useRef(true);
  const reload = useCallback(() => {
    const run = async () => {
      try {
        const next = await loadCatalog();
        if (mounted.current) setCatalog(next);
      } catch (cause) {
        console.warn("mini window: failed to list projects", cause);
      }
    };
    void run();
  }, []);
  useEffect(() => {
    mounted.current = true;
    reload();
    window.addEventListener("focus", reload);
    const unlisten = onWorktreeChanged(reload);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", reload);
      void unlisten.then((stop) => stop());
    };
  }, [reload]);
  return { catalog, reload };
}

/** The local home directory every new mini tab opens in (`null` until resolved). */
export function useHomeDir(): string | null {
  const [dir, setDir] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    homeDir()
      .then((path) => {
        if (!cancelled) setDir(path);
        return undefined;
      })
      .catch((cause: unknown) => console.error("mini window: no home directory", cause));
    return () => {
      cancelled = true;
    };
  }, []);
  return dir;
}
