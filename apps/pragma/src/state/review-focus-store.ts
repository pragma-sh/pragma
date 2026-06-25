import { useSyncExternalStore } from "react";

/**
 * Ephemeral "scroll this review file into view" request, keyed by `prNumber`. A
 * module-level store read through `useSyncExternalStore`, mirroring
 * `review-done-store.ts`: it is **never** in the workspace reducer and **never**
 * persisted.
 *
 * The flow is deliberately one-shot and explicit (so the review tab only jumps
 * when the user actually clicks-and-selects a file, never on its own): clicking a
 * file row in the PR's "Files changed" list calls `requestReviewFocus`, the
 * matching `ReviewTab` scrolls that file's section into view, and then clears the
 * request via `clearReviewFocus`. Re-clicking the same file re-requests it.
 */
const focusByPr = new Map<number, string>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/** Requests that the review tab for `prNumber` scroll `path` into view. */
export function requestReviewFocus(prNumber: number, path: string): void {
  focusByPr.set(prNumber, path);
  emit();
}

/** Clears a pending focus request once it has been consumed (scrolled to). */
export function clearReviewFocus(prNumber: number): void {
  if (focusByPr.delete(prNumber)) {
    emit();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribes a review tab to its pending focus path (or `null` when none). */
export function useReviewFocus(prNumber: number | null | undefined): string | null {
  const read = () => (prNumber == null ? null : (focusByPr.get(prNumber) ?? null));
  return useSyncExternalStore(subscribe, read, read);
}
