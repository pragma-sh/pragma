import type { ScriptList } from "@pragma-sh/sdk";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";

import { useConnection } from "./connection-context";
import { settle } from "./host-read";

/** A worktree's project scripts, and how the last read went. */
export interface Scripts {
  list: ScriptList | null;
  loading: boolean;
  /** Re-reads the list — after a run starts or stops, or on focus. */
  reload: () => void;
  /** Starts a script, or focuses the run already going, and returns it. */
  run: (name: string) => Promise<{ runId: string; tabIds: string[] }>;
  /** Ends a run and the terminals it opened. */
  stop: (runId: string) => Promise<void>;
}

/**
 * The named run scripts a worktree can start.
 *
 * The host owns the run, so this is a thin read: whether a script is going is
 * its answer, not a guess assembled from which tabs happen to be open. The list
 * is re-read on focus and after every start or stop, because a run started from
 * the desktop is just as real as one started here.
 */
export function useScripts(worktreeId: string): Scripts {
  const { client, handleUnauthorized } = useConnection();
  const [list, setList] = useState<ScriptList | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!client || !worktreeId) {
      setList(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    const load = async (): Promise<void> => {
      const result = await settle(client.scripts.list(worktreeId), handleUnauthorized);
      if (cancelled) return;
      // A failed read leaves the previous list in place: an unreachable host
      // is not the same as a project without scripts.
      if (result.ok) setList(result.value);
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, handleUnauthorized, revision, worktreeId]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  const run = useCallback(
    async (name: string) => {
      if (!client) throw new Error("Not connected to a host");
      const started = await client.scripts.run({
        worktreeId,
        name,
        // A fresh id per tap: the host still refuses to start a second run of a
        // script that is already going, so this only dedupes a retried request.
        requestId: `${worktreeId}:${name}:${Date.now()}`,
      });
      reload();
      return { runId: started.runId, tabIds: started.tabIds };
    },
    [client, reload, worktreeId],
  );

  const stop = useCallback(
    async (runId: string) => {
      if (!client) throw new Error("Not connected to a host");
      await client.scripts.stop(runId);
      reload();
    },
    [client, reload],
  );

  return { list, loading, reload, run, stop };
}
