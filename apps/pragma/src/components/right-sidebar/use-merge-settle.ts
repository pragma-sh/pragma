import { useCallback, useEffect, useMemo, useRef } from "react";

import type { PullRequestSummary } from "@/lib/github";

/**
 * Gaps between the forced re-reads after a conflict fix is pushed. GitHub
 * recomputes `mergeable` in the background after a push, so the first reads
 * still report the old head (or `null` while it computes); the polls back off
 * until it settles.
 */
const MERGE_SETTLE_POLL_MS = [1_000, 2_000, 3_000, 5_000, 8_000, 13_000];

/**
 * Keeps a pull request shown as mergeable right after its conflict fix is
 * pushed, then polls until GitHub agrees. `start` marks the push; `apply`
 * filters every fetched summary: until GitHub reports a new head with a
 * computed `mergeable`, the summary is shown as mergeable. The first settled
 * read wins, conflicting or not, and stops the polling.
 */
export function useMergeSettle() {
  /** The head GitHub reported before the push; `null` when nothing is settling. */
  const staleHead = useRef<string | null>(null);
  const timers = useRef<number[]>([]);

  const stop = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
    staleHead.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const apply = useCallback(
    (pr: PullRequestSummary): PullRequestSummary => {
      if (staleHead.current === null) return pr;
      if (pr.headSha !== staleHead.current && pr.mergeable !== null) {
        stop();
        return pr;
      }
      return { ...pr, mergeable: true };
    },
    [stop],
  );

  const start = useCallback(
    (pr: PullRequestSummary, reload: () => Promise<void>): PullRequestSummary => {
      stop();
      staleHead.current = pr.headSha;
      let at = 0;
      timers.current = MERGE_SETTLE_POLL_MS.map((gap, index) => {
        at += gap;
        const last = index === MERGE_SETTLE_POLL_MS.length - 1;
        return window.setTimeout(() => {
          // Out of retries: show whatever GitHub reports next, settled or not.
          if (last) staleHead.current = null;
          void reload();
        }, at);
      });
      return { ...pr, mergeable: true };
    },
    [stop],
  );

  // Stable, so a caller's `useCallback` that reads `apply` keeps its identity.
  return useMemo(() => ({ apply, start }), [apply, start]);
}
