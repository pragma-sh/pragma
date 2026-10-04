import type { GitHubBranches } from "@pragma/sdk";

/** Builds sorted merge-target choices without ES2023 methods missing from Hermes. */
export function baseBranchChoices(branches: GitHubBranches | null): string[] {
  const choices = [
    ...new Set([...(branches?.branches ?? []), ...(branches ? [branches.defaultBranch] : [])]),
  ].filter((branch) => branch !== branches?.headBranch);
  // oxlint-disable-next-line unicorn/no-array-sort
  return choices.sort((a, b) => a.localeCompare(b));
}
