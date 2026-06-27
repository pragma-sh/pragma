import { useEffect, useRef } from "react";

import type { FileChange } from "@pragma/constants";
import type { Channel } from "@tauri-apps/api/core";

import { watchWorktreeFiles } from "@/lib/tauri";

/**
 * Shared, ref-counted registry of live worktree filesystem watches.
 *
 * The server runs one recursive watcher per worktree; this mirrors that on the
 * client by opening **one** Tauri channel per worktree and fanning its
 * {@link FileChange}s out to every subscribed listener. Tauri has no
 * channel-close API, so a worktree's channel stays open for the app session once
 * created — there are only as many channels as worktrees the user actually
 * views, and the server reuses a single watcher per worktree regardless.
 */

type Listener = (change: FileChange) => void;

interface WorktreeWatch {
  listeners: Set<Listener>;
  channel: Promise<Channel<FileChange>>;
}

const watches = new Map<string, WorktreeWatch>();

function dispatch(worktreeId: string, change: FileChange): void {
  const watch = watches.get(worktreeId);
  if (!watch) {
    return;
  }
  for (const listener of watch.listeners) {
    listener(change);
  }
}

/**
 * Subscribes `listener` to filesystem changes for a worktree, lazily opening the
 * shared channel on first use. Returns an unsubscribe function.
 */
export function subscribeToWorktreeFiles(worktreeId: string, listener: Listener): () => void {
  let watch = watches.get(worktreeId);
  if (!watch) {
    watch = {
      listeners: new Set<Listener>(),
      channel: watchWorktreeFiles(worktreeId, (change) => dispatch(worktreeId, change)),
    };
    // Keep the registry usable even if the watch fails to start (e.g. the
    // worktree was removed); listeners simply never receive events.
    watch.channel.catch(() => undefined);
    watches.set(worktreeId, watch);
  }
  watch.listeners.add(listener);
  return () => {
    watches.get(worktreeId)?.listeners.delete(listener);
  };
}

/**
 * Subscribes a component to a worktree's filesystem changes for as long as it is
 * mounted. The latest `onChange` is always invoked (stored in a ref) without
 * re-subscribing, so callers can close over fresh props/state freely. An empty
 * `worktreeId` (e.g. no worktree selected) is a no-op.
 */
export function useWorktreeFileChange(
  worktreeId: string,
  onChange: (change: FileChange) => void,
): void {
  const handlerRef = useRef(onChange);
  handlerRef.current = onChange;
  useEffect(() => {
    if (!worktreeId) {
      return;
    }
    return subscribeToWorktreeFiles(worktreeId, (change) => handlerRef.current(change));
  }, [worktreeId]);
}
