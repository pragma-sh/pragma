import { useCallback, useEffect, useState } from "react";
import { constants } from "@pragma-sh/constants";

import { errorMessage } from "@/lib/errors";
import {
  cancelWorktreeStorageScan,
  deleteIgnoredFolder,
  listProjects,
  listWorktrees,
  scanWorktreeStorage,
  type ConfigScope,
} from "@/lib/tauri";

import { withoutFolder, type ScanState, type StorageTarget } from "./storage-model";

/** Loads the worktrees a scope covers: every project's, or one project's. */
export function useStorageTargets(
  scope: ConfigScope,
  projectId: string | null,
): { targets: StorageTarget[] | null; error: string | null } {
  const [targets, setTargets] = useState<StorageTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setTargets(null);
    setError(null);
    void (async () => {
      const projects = await listProjects();
      const inScope =
        scope === "project" ? projects.filter((project) => project.id === projectId) : projects;
      const perProject = await Promise.all(
        inScope.map(async (project) =>
          (await listWorktrees(project.id)).map((worktree) => ({ project, worktree })),
        ),
      );
      if (live) setTargets(perProject.flat());
    })().catch((cause: unknown) => {
      if (live) setError(errorMessage(cause));
    });
    return () => {
      live = false;
    };
  }, [scope, projectId]);

  return { targets, error };
}

/** Result of {@link useStorageScan}. */
export interface StorageScan {
  states: Record<string, ScanState>;
  /** Scans every target again from scratch. */
  rescan: () => void;
  /** Deletes one gitignored folder and drops it from the results. */
  deleteFolder: (worktreeId: string, path: string) => Promise<void>;
}

/**
 * Scans `targets` a few at a time while the caller is mounted.
 *
 * The walk is expensive, so it only happens while the Storage page is open:
 * unmounting (or a new target list) stops queueing scans and asks the host to
 * cancel the ones already running, and their late answers are ignored.
 */
export function useStorageScan(targets: readonly StorageTarget[] | null): StorageScan {
  const [states, setStates] = useState<Record<string, ScanState>>({});
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!targets) {
      setStates({});
      return;
    }
    let live = true;
    const queue = [...targets];
    const running = new Map<string, string>();
    setStates(
      Object.fromEntries(targets.map((target) => [target.worktree.id, { status: "pending" }])),
    );

    const scanNext = async (): Promise<void> => {
      const target = queue.shift();
      if (!target || !live) return;
      const worktreeId = target.worktree.id;
      const scanId = `storage-${generation}-${worktreeId}-${crypto.randomUUID()}`;
      running.set(worktreeId, scanId);
      let next: ScanState;
      try {
        next = { status: "done", storage: await scanWorktreeStorage(worktreeId, scanId) };
      } catch (cause) {
        next = { status: "error", error: errorMessage(cause) };
      }
      running.delete(worktreeId);
      if (!live) return;
      setStates((current) => ({ ...current, [worktreeId]: next }));
      await scanNext();
    };

    const workers = Math.min(constants.storage.scanConcurrency, targets.length);
    for (let index = 0; index < workers; index += 1) void scanNext();

    return () => {
      live = false;
      for (const [worktreeId, scanId] of running) {
        void cancelWorktreeStorageScan(worktreeId, scanId).catch(() => undefined);
      }
    };
  }, [targets, generation]);

  const rescan = useCallback(() => setGeneration((value) => value + 1), []);

  const deleteFolder = useCallback(async (worktreeId: string, path: string) => {
    await deleteIgnoredFolder(worktreeId, path);
    setStates((current) => {
      const state = current[worktreeId];
      if (state?.status !== "done") return current;
      return {
        ...current,
        [worktreeId]: { status: "done", storage: withoutFolder(state.storage, path) },
      };
    });
  }, []);

  return { states, rescan, deleteFolder };
}
