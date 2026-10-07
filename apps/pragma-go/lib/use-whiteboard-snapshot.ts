import { useCallback } from "react";

import { useConnection } from "./connection-context";
import { settle } from "./host-read";
import { getWhiteboardSnapshot, type ScratchpadWhiteboardSnapshot } from "./whiteboard-snapshot";

/**
 * The scratchpad viewer's whiteboard loader for one worktree, bound to the
 * current host. A 401 still unpairs; every host failure is rethrown so the
 * viewer can show it.
 */
export function useWhiteboardSnapshotLoader(
  worktreeId: string,
): (
  id: string,
  knownVersion?: number,
  dark?: boolean,
) => Promise<ScratchpadWhiteboardSnapshot | null> {
  const { client, handleUnauthorized } = useConnection();
  return useCallback(
    async (id: string, knownVersion?: number, dark?: boolean) => {
      if (!client) throw new Error("Host is unavailable");
      const result = await settle(
        getWhiteboardSnapshot(client.whiteboards, worktreeId, id, knownVersion, dark),
        handleUnauthorized,
      );
      if (!result.ok) throw result.error;
      return result.value;
    },
    [client, handleUnauthorized, worktreeId],
  );
}
