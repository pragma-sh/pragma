import { useEffect, useRef, useState } from "react";

import { toast } from "sonner";

import {
  parseScratchpadComments,
  type ScratchpadComment,
} from "@/components/scratchpad/scratchpad-comments";
import { scratchpadCommentsPath } from "@/components/scratchpad/scratchpad-document";
import { errorMessage } from "@/lib/errors";
import { pathExists, readFile, writeFile } from "@/lib/tauri";

/**
 * Unsaved comments per `worktreeId:path`, kept module-level so remounting the tab
 * (mode switch, reload) does not lose edits that have not reached disk yet.
 */
const commentDrafts = new Map<string, ScratchpadComment[]>();
/** In-flight write per `worktreeId:path`, so concurrent saves cannot interleave. */
const commentWriteQueues = new Map<string, Promise<void>>();
/** Debounce before flushing position-only comment drift back to disk. */
const COMMENT_FLUSH_DELAY_MS = 250;

export interface ScratchpadComments {
  comments: ScratchpadComment[];
  /** False until the sidecar JSON has been read; commenting stays disabled meanwhile. */
  commentsLoaded: boolean;
  updateComments: (next: ScratchpadComment[]) => void;
}

/**
 * Loads a scratchpad's sibling comments JSON and persists edits back to it.
 * Content edits write immediately; position-only drift from editing the document
 * is debounced, since it fires on every keystroke.
 */
export function useScratchpadComments(
  worktreeId: string,
  filePath: string | null,
  ready: boolean,
): ScratchpadComments {
  const commentsDirtyRef = useRef(false);
  const commentsRef = useRef<ScratchpadComment[]>([]);
  const [comments, setComments] = useState<ScratchpadComment[]>([]);
  const [commentsLoaded, setCommentsLoaded] = useState(false);

  useEffect(() => {
    if (!filePath || !ready) return;
    let current = true;
    const apply = (next: ScratchpadComment[]): void => {
      if (!current) return;
      commentsRef.current = next;
      setComments(next);
      setCommentsLoaded(true);
    };
    setCommentsLoaded(false);
    const draft = commentDrafts.get(`${worktreeId}:${scratchpadCommentsPath(filePath)}`);
    if (draft) {
      apply(draft);
    } else {
      void readScratchpadComments(worktreeId, filePath)
        .catch((cause: unknown) => {
          if (current) toast.error(`Comments: ${errorMessage(cause)}`);
          return [];
        })
        .then(apply);
    }
    return () => {
      current = false;
    };
  }, [filePath, ready, worktreeId]);

  const flush = (next: readonly ScratchpadComment[], key: string): void => {
    void writeScratchpadComments(worktreeId, filePath ?? "", next)
      .then(() => {
        if (commentsRef.current === next) {
          commentsDirtyRef.current = false;
          commentDrafts.delete(key);
        }
        return undefined;
      })
      .catch((cause: unknown) => toast.error(`Comments: ${errorMessage(cause)}`));
  };

  useEffect(() => {
    if (!filePath || !commentsLoaded || !commentsDirtyRef.current) return;
    const key = `${worktreeId}:${scratchpadCommentsPath(filePath)}`;
    const timeout = setTimeout(() => flush(comments, key), COMMENT_FLUSH_DELAY_MS);
    return () => clearTimeout(timeout);
    // `flush` closes over the same inputs this effect already depends on.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [comments, commentsLoaded, filePath, worktreeId]);

  const updateComments = (next: ScratchpadComment[]): void => {
    const meaningful = commentsMeaningfullyChanged(commentsRef.current, next);
    commentsDirtyRef.current = true;
    commentsRef.current = next;
    if (filePath) {
      const key = `${worktreeId}:${scratchpadCommentsPath(filePath)}`;
      commentDrafts.set(key, next);
      if (meaningful) flush(next, key);
    }
    setComments(next);
  };

  return { comments, commentsLoaded, updateComments };
}

/** Reads the sibling comments JSON, treating a missing file as "no comments". */
async function readScratchpadComments(
  worktreeId: string,
  filePath: string,
): Promise<ScratchpadComment[]> {
  const path = scratchpadCommentsPath(filePath);
  if (!(await pathExists(worktreeId, path))) return [];
  const file = await readFile(worktreeId, path);
  return parseScratchpadComments(file.text);
}

function writeScratchpadComments(
  worktreeId: string,
  filePath: string,
  comments: readonly ScratchpadComment[],
): Promise<void> {
  const path = scratchpadCommentsPath(filePath);
  const key = `${worktreeId}:${path}`;
  const queued = (commentWriteQueues.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => writeFile(worktreeId, path, `${JSON.stringify(comments, null, 2)}\n`));
  commentWriteQueues.set(key, queued);
  const cleanup = (): void => {
    if (commentWriteQueues.get(key) === queued) commentWriteQueues.delete(key);
  };
  void queued.then(cleanup, cleanup);
  return queued;
}

/** True when a comment's content changed, as opposed to only its document position. */
function commentsMeaningfullyChanged(
  previous: readonly ScratchpadComment[],
  next: readonly ScratchpadComment[],
): boolean {
  if (previous.length !== next.length) return true;
  return next.some((comment, index) => {
    const before = previous[index];
    return (
      !before ||
      before.id !== comment.id ||
      before.quote !== comment.quote ||
      before.text !== comment.text ||
      before.resolvedAt !== comment.resolvedAt
    );
  });
}
