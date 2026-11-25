import type { GitHubRepoRef } from "@pragma-sh/constants";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useMergePermission } from "@/hooks/use-merge-permission";
import type { PullRequestStack, PullRequestSummary } from "@/lib/github";

/** What a "merge now" control shows, shared by the merge button and the CI watch menu. */
export interface MergeActionState {
  label: string;
  disabled: boolean;
  merging: boolean;
  /** The user's merge permission in the base repo; undefined while loading. */
  allowed: boolean | null | undefined;
  /** Stack membership; undefined while loading. */
  stack: PullRequestStack | null | undefined;
  target: { owner: string; repo: string };
}

/**
 * Derives the merge control's label and enablement. Disabled while stack
 * membership or the user's merge permission is still loading, and when the
 * user cannot merge in the PR's base repository.
 */
export function useMergeActionState({
  merging,
  pr,
  repo,
  stack,
}: {
  merging: boolean;
  pr: PullRequestSummary;
  repo: GitHubRepoRef;
  stack: PullRequestStack | null | undefined;
}): MergeActionState {
  const allowed = useMergePermission(repo, pr);
  const label =
    stack === undefined
      ? "Checking stack membership…"
      : stack
        ? "Merge stack"
        : "Merge pull request";
  return {
    label,
    disabled: merging || stack === undefined || allowed === undefined || allowed === false,
    merging,
    allowed,
    stack,
    target: pr.baseRepo ?? repo,
  };
}

/** The merge button shown while the PR is mergeable and no CI watch is offered instead. */
export function MergeAction({
  onConfirm,
  state,
}: {
  onConfirm: () => void;
  state: MergeActionState;
}) {
  return (
    <>
      <Button className="w-full" disabled={state.disabled} onClick={onConfirm} size="sm">
        {state.merging ? <Loader2 className="animate-spin" /> : null}
        {state.label}
      </Button>
      {state.allowed === false ? (
        <p className="text-xs text-muted-foreground">
          You don&apos;t have permission to merge pull requests in {state.target.owner}/
          {state.target.repo}.
        </p>
      ) : state.stack === undefined ? (
        <p className="text-xs text-muted-foreground">
          Merge stays disabled until GitHub confirms stack membership.
        </p>
      ) : null}
    </>
  );
}
