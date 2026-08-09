import type { ScratchpadFile } from "@pragma/sdk";
import { PragmaGatewayError } from "@pragma/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useConnection } from "./connection-context";
import { useProjectRootPath, useWorktree } from "./data/data-context";
import { useViewedProjectRoot } from "./use-viewed-project";

/** A worktree's managed scratchpads, and how the last load went. */
export interface Scratchpads {
  scratchpads: ScratchpadFile[];
  loading: boolean;
  /** Re-reads the list from the host (after a comment write, or on focus). */
  reload: () => void;
}

/**
 * Lists one worktree's scratchpads through the host.
 *
 * Unlike the desktop there is no file watcher here, so the list is re-read on
 * demand: whenever the screen mounts, and whenever a caller asks. A failure
 * leaves the previous list in place rather than blanking a section the user is
 * reading — the host being briefly unreachable is not the same as the worktree
 * having no scratchpads.
 */
export function useScratchpads(worktreeId: string): Scratchpads {
  const { client, handleUnauthorized } = useConnection();
  const worktree = useWorktree(worktreeId);
  const root = worktree?.path;
  const [scratchpads, setScratchpads] = useState<ScratchpadFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!client || !root) {
      setScratchpads([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    client.scratchpads
      .getScratchpads({ root })
      .then((files) => {
        if (!cancelled) setScratchpads(files);
        return undefined;
      })
      .catch((error: unknown) => {
        if (error instanceof PragmaGatewayError && error.httpStatus === 401) handleUnauthorized();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, handleUnauthorized, revision, root]);

  return { scratchpads, loading, reload };
}

/** One scratchpad in a worktree, resolved by its worktree-relative path. */
export interface Scratchpad {
  scratchpad: ScratchpadFile | undefined;
  /** The worktree's absolute host path, for reads and writes beside the file. */
  root: string | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * The single scratchpad a screen is showing, resolved from the worktree's list
 * so the source, the attachment, and the list stay one fetch rather than three.
 * Also reports the project this screen is viewing, so the theme layers that
 * project's `.pragma/theme.json` while it is in front.
 */
export function useScratchpad(worktreeId: string, filePath: string): Scratchpad {
  const worktree = useWorktree(worktreeId);
  useViewedProjectRoot(useProjectRootPath(worktree?.projectId));
  const { scratchpads, loading, reload } = useScratchpads(worktreeId);
  const scratchpad = useMemo(
    () => scratchpads.find((file) => file.filePath === filePath),
    [filePath, scratchpads],
  );
  return { scratchpad, root: worktree?.path, loading, reload };
}
