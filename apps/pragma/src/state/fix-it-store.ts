import { useSyncExternalStore } from "react";

/**
 * One code-review comment the user has flagged to fix later, captured so it can be
 * rendered in the fix-it list and folded into an agent prompt without re-fetching
 * the PR threads.
 */
export interface FixItComment {
  /** GraphQL review-thread node id; the stable identity within a PR's list. */
  threadId: string;
  path: string;
  line: number | null;
  /** The thread's comment bodies, already joined for display and prompting. */
  body: string;
}

/**
 * Ephemeral "fix it list" of review comments, keyed by `prNumber`. A module-level
 * store read through `useSyncExternalStore`, mirroring `review-done-store.ts`: it
 * is **never** in the workspace reducer and **never** persisted — flagging a
 * comment to fix is transient, per-session UI, recomputed fresh each session.
 */
const byPr = new Map<number, FixItComment[]>();
const listeners = new Set<() => void>();

// Stable empty reference so `useSyncExternalStore` doesn't loop on an unflagged PR.
const EMPTY: readonly FixItComment[] = [];

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/** Adds a comment to a PR's fix-it list, ignoring duplicates (by `threadId`). */
export function addFixItComment(prNumber: number, comment: FixItComment): void {
  const list = byPr.get(prNumber) ?? [];
  if (list.some((entry) => entry.threadId === comment.threadId)) {
    return;
  }
  byPr.set(prNumber, [...list, comment]);
  emit();
}

/** Removes one comment from a PR's fix-it list; only notifies when it changes. */
export function removeFixItComment(prNumber: number, threadId: string): void {
  const list = byPr.get(prNumber);
  if (!list) {
    return;
  }
  const next = list.filter((entry) => entry.threadId !== threadId);
  if (next.length === list.length) {
    return;
  }
  if (next.length === 0) {
    byPr.delete(prNumber);
  } else {
    byPr.set(prNumber, next);
  }
  emit();
}

/** Clears a PR's entire fix-it list (e.g. once an agent has been launched for it). */
export function clearFixItComments(prNumber: number): void {
  if (byPr.delete(prNumber)) {
    emit();
  }
}

/** The current fix-it list for a PR (a stable empty array when none). */
export function getFixItComments(prNumber: number): readonly FixItComment[] {
  return byPr.get(prNumber) ?? EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribes a component to a PR's fix-it list. */
export function useFixItComments(prNumber: number): readonly FixItComment[] {
  return useSyncExternalStore(
    subscribe,
    () => getFixItComments(prNumber),
    () => getFixItComments(prNumber),
  );
}

/** Subscribes a component to whether one thread is currently on the fix-it list. */
export function useIsFixItComment(prNumber: number, threadId: string): boolean {
  const read = () => byPr.get(prNumber)?.some((entry) => entry.threadId === threadId) ?? false;
  return useSyncExternalStore(subscribe, read, read);
}
