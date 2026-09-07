import type { GitHubPullRequest } from "@pragma/constants";

import { createGitHubClient } from "./index";

/** Which repository and branch a lookup or publish is about. */
export interface PullRequestTarget {
  owner: string;
  repo: string;
  /** Exact head branch name. A fork's head is `owner:branch`. */
  head: string;
  baseUrl?: string;
}

/** Everything a publish needs beyond the target. */
export interface PublishPullRequestInput extends PullRequestTarget {
  title: string;
  body: string;
  base: string;
  draft: boolean;
}

/**
 * Finds the pull request for a head branch, open or closed.
 *
 * Matching is by repository plus **exact** head branch, which is what makes a
 * pull request opened outside Pragma — on the web, from another machine — show
 * up here. A closed or merged one still matches: a worktree whose PR was merged
 * should say so, not look as if it never had one.
 */
export async function findPullRequest(
  token: string,
  target: PullRequestTarget,
): Promise<GitHubPullRequest | null> {
  const client = createGitHubClient(token, target.baseUrl);
  const { data } = await client.rest.pulls.list({
    owner: target.owner,
    repo: target.repo,
    head: qualifiedHead(target),
    state: "all",
    per_page: 10,
  });
  // Newest first: a branch reused after its first PR merged has more than one,
  // and the current one is the one the user is working in.
  const newest = data.toSorted(
    (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
  )[0];
  return newest ? toPullRequest(newest) : null;
}

/**
 * Creates a pull request, or returns the one that already exists.
 *
 * GitHub rejects a duplicate for the same head with a 422; that is a success
 * for this operation, not a failure — the request the caller wanted is already
 * there, and reporting an error would invite them to try again and again.
 */
export async function publishPullRequest(
  token: string,
  input: PublishPullRequestInput,
): Promise<GitHubPullRequest> {
  const client = createGitHubClient(token, input.baseUrl);
  try {
    const { data } = await client.rest.pulls.create({
      owner: input.owner,
      repo: input.repo,
      head: qualifiedHead(input),
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft,
    });
    return toPullRequest(data);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await findPullRequest(token, input);
    if (!existing) throw error;
    return existing;
  }
}

/** A fork's head must be qualified; a same-repo branch must not be. */
function qualifiedHead(target: PullRequestTarget): string {
  return target.head.includes(":") ? target.head : `${target.owner}:${target.head}`;
}

/** Whether a create failed because the pull request is already open. */
function isAlreadyExists(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  if (status !== 422) return false;
  return JSON.stringify((error as { response?: unknown }).response ?? "").includes(
    "already exists",
  );
}

/** Narrows an API pull request to the fields that cross the wire. */
function toPullRequest(data: {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  head: { ref: string };
  base: { ref: string };
}): GitHubPullRequest {
  return {
    number: data.number,
    title: data.title,
    // The canonical `https://github.com/owner/repo/pull/number`, as GitHub
    // itself reports it: a client opens this with the platform link handler, so
    // the OS can route it to the GitHub app when the user has one.
    url: data.html_url,
    state: pullRequestState(data),
    headBranch: data.head.ref,
    baseBranch: data.base.ref,
  };
}

function pullRequestState(data: {
  state: string;
  draft?: boolean;
  merged_at?: string | null;
}): GitHubPullRequest["state"] {
  if (data.merged_at) return "merged";
  if (data.state === "closed") return "closed";
  return data.draft ? "draft" : "open";
}
