import type { PragmaClient } from "@pragma/sdk";
import {
  parseScratchpadComments,
  scratchpadCommentsPath,
  serializeScratchpadComments,
  type ScratchpadComment,
} from "@pragma/scratchpad-viewer";
import { useCallback, useEffect, useRef, useState } from "react";

import { useConnection } from "./connection-context";

/** A scratchpad's comment thread file, and the writes that keep it current. */
export interface ScratchpadComments {
  comments: ScratchpadComment[];
  /** False until the sibling file has been read; commenting stays off meanwhile. */
  loaded: boolean;
  /** Replaces the set and writes it back to the host. */
  save: (next: ScratchpadComment[]) => Promise<void>;
}

/**
 * Reads and writes the sibling `<file>.comments.json` the desktop owns.
 *
 * It is the same file, in the same shape, on purpose: a comment left on a phone
 * has to show up in the desktop's "Resolve comments" handoff, and one left on
 * the desktop has to be visible here. Writes are serialized through a single
 * in-flight promise so two quick submissions cannot interleave and lose one.
 */
export function useScratchpadComments(
  worktreeRoot: string | undefined,
  filePath: string,
): ScratchpadComments {
  const { client } = useConnection();
  const [comments, setComments] = useState<ScratchpadComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!client || !worktreeRoot) return undefined;
    let cancelled = false;
    setLoaded(false);
    readComments(client, worktreeRoot, filePath)
      .then((existing) => {
        if (!cancelled) {
          setComments(existing);
          setLoaded(true);
        }
        return undefined;
      })
      .catch(() => {
        // An unreadable comment file must not block reading the scratchpad; the
        // user simply starts from an empty thread rather than seeing an error
        // they cannot act on from a phone.
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, filePath, worktreeRoot]);

  const save = useCallback(
    async (next: ScratchpadComment[]): Promise<void> => {
      setComments(next);
      if (!client || !worktreeRoot) return;
      const previous = writeQueue.current;
      const write = (async () => {
        await previous.catch(() => undefined);
        await client.fs.writeFile({
          root: worktreeRoot,
          path: scratchpadCommentsPath(filePath),
          contents: serializeScratchpadComments(next),
        });
      })();
      writeQueue.current = write;
      await write;
    },
    [client, filePath, worktreeRoot],
  );

  return { comments, loaded, save };
}

/** Reads the sibling comment file, treating a missing one as "no comments". */
async function readComments(
  client: PragmaClient,
  root: string,
  filePath: string,
): Promise<ScratchpadComment[]> {
  const path = scratchpadCommentsPath(filePath);
  if (!(await client.fs.pathExists({ root, path }))) return [];
  const file = await client.fs.readFile({ root, path });
  if (file.binary || file.truncated) return [];
  return parseScratchpadComments(file.text);
}
