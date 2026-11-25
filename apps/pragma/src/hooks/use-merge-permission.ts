import type { GitHubRepoRef } from "@pragma-sh/constants";
import { useAsyncValue } from "@/hooks/use-async-value";
import { canMergePullRequests, type PullRequestSummary } from "@/lib/github";

/**
 * Whether the signed-in user may merge this PR in its base repository:
 * undefined while loading, and null when GitHub would not say (GitHub still
 * enforces it on the merge itself).
 */
export function useMergePermission(
  repo: GitHubRepoRef,
  pr: Pick<PullRequestSummary, "baseRepo">,
): boolean | null | undefined {
  const target = pr.baseRepo ?? repo;
  return useAsyncValue(
    `${target.owner}/${target.repo}`,
    () => canMergePullRequests({ owner: target.owner, repo: target.repo }),
    null,
  );
}
