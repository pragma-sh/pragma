import { useSyncExternalStore } from "react";

/**
 * Ephemeral "done reviewing" state for PR review files, keyed by
 * `prNumber:path`. A module-level store read through `useSyncExternalStore`,
 * mirroring `editor-dirty-store.ts`: it is **never** in the workspace reducer and
 * **never** persisted — marking a file reviewed is transient, per-session UI that
 * collapses the file's diff, recomputed fresh each session.
 */
const done = new Set<string>();
const listeners = new Set<() => void>();

function keyOf(prNumber: number, path: string): string {
  return `${prNumber}:${path}`;
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/** Marks a review file done/not-done; only notifies when the value changes. */
export function setReviewDone(prNumber: number, path: string, value: boolean): void {
  const key = keyOf(prNumber, path);
  if (done.has(key) === value) {
    return;
  }
  if (value) {
    done.add(key);
  } else {
    done.delete(key);
  }
  emit();
}

/** Whether a review file is currently marked done. */
export function isReviewDone(prNumber: number, path: string): boolean {
  return done.has(keyOf(prNumber, path));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribes a component to one review file's done flag. */
export function useReviewDone(prNumber: number, path: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isReviewDone(prNumber, path),
    () => isReviewDone(prNumber, path),
  );
}
