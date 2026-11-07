import { useEffect, useMemo, useState } from "react";
import type { GitHubRepoRef, Worktree } from "@pragma-sh/constants";
import {
  findPullRequestForBranch,
  getPullRequestChecksState,
  pullRequestLifecycle,
  type ChecksStatus,
  type GitHubPrLifecycle,
  type PullRequestSummary,
} from "@/lib/github";
import { githubRepoRef } from "@/lib/tauri";

const PR_STATUS_REFRESH_INTERVAL_MS = 10_000;
/** Lifecycles whose PR still runs CI worth showing; a closed or merged one is history. */
const LIVE_PR_LIFECYCLES: ReadonlySet<GitHubPrLifecycle> = new Set(["open", "draft", "merging"]);

interface WorktreePr {
  lifecycle: GitHubPrLifecycle;
  number: number | null;
  checks: ChecksStatus["state"] | null;
}

/** The PR's CI rollup, or null when it is not live or the lookup fails. */
async function liveChecksState(
  repo: GitHubRepoRef,
  pr: PullRequestSummary | null,
  lifecycle: GitHubPrLifecycle,
): Promise<ChecksStatus["state"] | null> {
  if (!pr || !LIVE_PR_LIFECYCLES.has(lifecycle)) return null;
  try {
    return await getPullRequestChecksState(repo, pr);
  } catch {
    // CI status is decoration: a failed rollup must not hide the PR itself.
    return null;
  }
}

function samePrs(a: Record<string, WorktreePr>, b: Record<string, WorktreePr>): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(
      (key) =>
        a[key]?.lifecycle === b[key]?.lifecycle &&
        a[key]?.number === b[key]?.number &&
        a[key]?.checks === b[key]?.checks,
    )
  );
}

/** Shared cached PR discovery for sidebar rows and live-worktree board cards. */
export function useWorktreePrLifecycles(
  worktrees: Worktree[],
  authenticated: boolean,
): {
  prLifecycleByWorktreeId: Record<string, GitHubPrLifecycle>;
  prNumberByWorktreeId: Record<string, number>;
  prChecksByWorktreeId: Record<string, ChecksStatus["state"]>;
} {
  const [prs, setPrs] = useState<Record<string, WorktreePr>>({});
  useEffect(() => {
    const children = worktrees.filter((worktree) => !worktree.isMain && worktree.parentId);
    if (!authenticated || !children.length) {
      setPrs((previous) => (Object.keys(previous).length ? {} : previous));
      return;
    }
    let cancelled = false;
    let inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const entries = await Promise.all(
          children.map(async (worktree) => {
            try {
              const repo = await githubRepoRef(worktree.id);
              const pr = await findPullRequestForBranch(repo, { includeClosed: true });
              const lifecycle = pullRequestLifecycle(pr);
              const checks = await liveChecksState(repo, pr, lifecycle);
              return [worktree.id, { lifecycle, number: pr?.number ?? null, checks }] as const;
            } catch {
              // A transient lookup failure must not erase the last known PR.
              return [worktree.id, undefined] as const;
            }
          }),
        );
        if (cancelled) return;
        setPrs((previous) => {
          const next: Record<string, WorktreePr> = {};
          for (const [id, result] of entries) {
            const resolved = result ?? previous[id];
            if (resolved) next[id] = resolved;
          }
          return samePrs(previous, next) ? previous : next;
        });
      } finally {
        inFlight = false;
      }
    }
    void refresh();
    const interval = setInterval(() => {
      if (!document.hidden) void refresh();
    }, PR_STATUS_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [worktrees, authenticated]);
  return useMemo(() => {
    const prLifecycleByWorktreeId: Record<string, GitHubPrLifecycle> = {};
    const prNumberByWorktreeId: Record<string, number> = {};
    const prChecksByWorktreeId: Record<string, ChecksStatus["state"]> = {};
    for (const [id, pr] of Object.entries(prs)) {
      prLifecycleByWorktreeId[id] = pr.lifecycle;
      if (pr.number !== null) prNumberByWorktreeId[id] = pr.number;
      if (pr.checks !== null) prChecksByWorktreeId[id] = pr.checks;
    }
    return { prLifecycleByWorktreeId, prNumberByWorktreeId, prChecksByWorktreeId };
  }, [prs]);
}
