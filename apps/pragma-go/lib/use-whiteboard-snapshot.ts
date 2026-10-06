import { PragmaGatewayError } from "@pragma-sh/sdk";
import { useCallback } from "react";

import { useConnection } from "./connection-context";
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
      try {
        return await getWhiteboardSnapshot(client.whiteboards, worktreeId, id, knownVersion, dark);
      } catch (cause) {
        if (cause instanceof PragmaGatewayError && cause.httpStatus === 401) handleUnauthorized();
        throw cause;
      }
    },
    [client, handleUnauthorized, worktreeId],
  );
}
