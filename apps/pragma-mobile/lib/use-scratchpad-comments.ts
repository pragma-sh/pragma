import type { ScratchpadBlock, ScratchpadComment } from "@pragma/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { useConnection } from "./connection-context";

/** A scratchpad's comment thread file, and the writes that keep it current. */
export interface ScratchpadComments {
  comments: ScratchpadComment[];
  /** False until the sibling file has been read; commenting stays off meanwhile. */
  loaded: boolean;
  /** Appends one comment anchored to a rendered block. */
  add: (block: ScratchpadBlock, text: string) => Promise<void>;
  /** Replaces the set and writes it back to the host. */
  save: (next: ScratchpadComment[]) => Promise<void>;
}

/**
 * Reads and writes the sibling comment file the desktop owns, through the SDK's
 * scratchpad namespace.
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
    client.scratchpads
      .getComments({ root: worktreeRoot, filePath })
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

  /** Runs one write after every write already queued, so none is lost. */
  const enqueue = useCallback(async (write: () => Promise<void>): Promise<void> => {
    const previous = writeQueue.current;
    const next = (async () => {
      await previous.catch(() => undefined);
      await write();
    })();
    writeQueue.current = next;
    await next;
  }, []);

  const save = useCallback(
    async (next: ScratchpadComment[]): Promise<void> => {
      setComments(next);
      if (!client || !worktreeRoot) return;
      await enqueue(() => client.scratchpads.setComments({ root: worktreeRoot, filePath }, next));
    },
    [client, enqueue, filePath, worktreeRoot],
  );

  const add = useCallback(
    async (block: ScratchpadBlock, text: string): Promise<void> => {
      if (!client || !worktreeRoot) return;
      await enqueue(async () => {
        const comment = await client.scratchpads.comment({
          root: worktreeRoot,
          filePath,
          block,
          text,
        });
        setComments((current) => [...current, comment]);
      });
    },
    [client, enqueue, filePath, worktreeRoot],
  );

  return { comments, loaded, add, save };
}
