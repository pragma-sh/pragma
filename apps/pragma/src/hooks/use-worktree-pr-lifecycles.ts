import { useEffect, useMemo, useState } from "react";
import type { Worktree } from "@pragma-sh/constants";
import {
  GITHUB_PR_REFRESH_INTERVAL_MS,
  findPullRequestForBranch,
  pullRequestLifecycle,
  type GitHubPrLifecycle,
} from "@/lib/github";
import { githubRepoRef } from "@/lib/tauri";

interface WorktreePr {
  lifecycle: GitHubPrLifecycle;
  number: number | null;
}

function samePrs(a: Record<string, WorktreePr>, b: Record<string, WorktreePr>): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(
      (key) => a[key]?.lifecycle === b[key]?.lifecycle && a[key]?.number === b[key]?.number,
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
              return [
                worktree.id,
                { lifecycle: pullRequestLifecycle(pr), number: pr?.number ?? null },
              ] as const;
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
    }, GITHUB_PR_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [worktrees, authenticated]);
  return useMemo(() => {
    const prLifecycleByWorktreeId: Record<string, GitHubPrLifecycle> = {};
    const prNumberByWorktreeId: Record<string, number> = {};
    for (const [id, pr] of Object.entries(prs)) {
      prLifecycleByWorktreeId[id] = pr.lifecycle;
      if (pr.number !== null) prNumberByWorktreeId[id] = pr.number;
    }
    return { prLifecycleByWorktreeId, prNumberByWorktreeId };
  }, [prs]);
}
