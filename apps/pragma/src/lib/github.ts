import type { GitHubRepoRef } from "@pragma/constants";
import { constants } from "@pragma/constants";
import { Octokit } from "octokit";

import { githubToken } from "@/lib/tauri";

/**
 * The **single** Octokit entry point — the only place `new Octokit()` happens,
 * mirroring the "only `lib/tauri.ts` calls `invoke()`" rule. Components call the
 * typed helpers below; they never construct a client. The token comes from the
 * Rust backend's on-disk `0600` token file via {@link githubToken} (the backend
 * owns the secret — see `src-tauri/src/github.rs`); the client is rebuilt
 * whenever the token changes (sign-in / sign-out).
 *
 * GitHub REST/GraphQL is JS-only (the Octokit SDK), so it lives here rather than
 * behind a Tauri command. Secrets, git, and OS work stay in Rust.
 */

/** Thrown when a GitHub call is attempted without a stored token. */
export class GitHubAuthError extends Error {
  constructor(message = "Not signed in to GitHub") {
    super(message);
    this.name = "GitHubAuthError";
  }
}

let cached: { token: string; client: Octokit } | null = null;

/** Lazily builds (and caches) the Octokit client for the current token. */
async function client(): Promise<Octokit> {
  const token = await githubToken();
  if (!token) {
    throw new GitHubAuthError();
  }
  if (cached?.token === token) {
    return cached.client;
  }
  const octokit = new Octokit({ auth: token, baseUrl: constants.github.apiBaseUrl });
  cached = { token, client: octokit };
  return octokit;
}

/** Drops the cached client so the next call rebuilds it (after sign-in/out). */
export function resetGitHubClient(): void {
  cached = null;
}

/** A pull request, reduced to the fields the UI renders. */
export interface PullRequestSummary {
  number: number;
  title: string;
  body: string;
  state: string;
  htmlUrl: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseRepo?: { owner: string; repo: string; cloneUrl: string } | null;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  user: GitHubActor | null;
}

/** A comment author / PR author. */
export interface GitHubActor {
  login: string;
  avatarUrl: string;
}

/** An issue (conversation) comment. */
export interface IssueComment {
  id: number;
  body: string;
  htmlUrl: string;
  createdAt: string;
  user: GitHubActor | null;
}

/** A Git author attached to a pull-request commit. */
export interface PullRequestCommitAuthor {
  name: string;
  user: GitHubActor | null;
}

/** One commit shown in a pull request's conversation timeline. */
export interface PullRequestCommit {
  authors: PullRequestCommitAuthor[];
  committedAt: string;
  message: string;
  sha: string;
  status: ChecksStatus["state"];
  url: string;
}

/** A file changed in a PR (review file list). */
export interface PullFile {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
}

/**
 * A submitted review — the parent that groups a reviewer's inline comments. Its
 * `body` is the overall review summary and `state` is the verdict (approved,
 * changes requested, commented).
 */
export interface PullReview {
  id: number;
  body: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  htmlUrl: string;
  submittedAt: string | null;
  user: GitHubActor | null;
}

/** A single inline review comment within a thread. */
export interface ReviewComment {
  id: number;
  body: string;
  createdAt: string;
  user: GitHubActor | null;
}

/** A review thread (a group of inline comments) with its resolved state. */
export interface ReviewThread {
  /** GraphQL node id, required to resolve the thread. */
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  comments: ReviewComment[];
}

/** Combined CI/status summary for a ref (the merge card). */
export interface CheckStatusItem {
  name: string;
  state: "success" | "failure" | "pending";
  url: string | null;
}

/** Combined CI/status summary for a ref (the merge card). */
export interface ChecksStatus {
  state: "success" | "failure" | "pending" | "neutral" | "none";
  total: number;
  passed: number;
  failed: number;
  pending: number;
  items: CheckStatusItem[];
}

/** Supported merge strategies. */
export type MergeMethod = "merge" | "squash" | "rebase";

/** Shape we read off an Octokit pull-request payload (list item or full get). */
interface PullLike {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  html_url: string;
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  head: { ref: string; sha: string };
  base: {
    ref: string;
    repo?: {
      name: string;
      clone_url: string;
      owner: { login: string } | null;
    } | null;
  };
  user: { login: string; avatar_url: string } | null;
}

function toActor(user: { login: string; avatar_url: string } | null): GitHubActor | null {
  return user ? { login: user.login, avatarUrl: user.avatar_url } : null;
}

function toSummary(pr: PullLike): PullRequestSummary {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    state: pr.state,
    htmlUrl: pr.html_url,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    baseRepo: pr.base.repo?.owner
      ? {
          owner: pr.base.repo.owner.login,
          repo: pr.base.repo.name,
          cloneUrl: pr.base.repo.clone_url,
        }
      : null,
    draft: pr.draft ?? false,
    merged: pr.merged ?? false,
    mergeable: pr.mergeable ?? null,
    user: toActor(pr.user),
  };
}

/**
 * Searches one repository for the open PR whose head is this worktree's branch.
 *
 * The `head`-filtered list is GitHub's documented path but is **eventually
 * consistent** — a just-opened PR can be missing from it for several seconds.
 * So when the filter comes back empty we fall back to scanning the open PRs and
 * matching `head.ref` locally, guaranteeing we surface an existing PR instead of
 * dropping back to the create view. The head filter is always qualified with the
 * origin owner (`owner:branch`), GitHub's cross-fork head syntax, so this works
 * whether `target` is the origin repo or its upstream parent.
 */
async function findPullInRepo(
  octokit: Octokit,
  repo: GitHubRepoRef,
  target: { owner: string; repo: string },
): Promise<PullRequestSummary | null> {
  const { data } = await octokit.rest.pulls.list({
    owner: target.owner,
    repo: target.repo,
    head: `${repo.owner}:${repo.headBranch}`,
    state: "open",
  });
  const filtered = data[0];
  if (filtered) {
    const { data: pull } = await octokit.rest.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: filtered.number,
    });
    return toSummary(pull);
  }
  const open = await octokit.paginate(octokit.rest.pulls.list, {
    owner: target.owner,
    repo: target.repo,
    state: "open",
    per_page: 100,
  });
  const match = open.find((pr) => pr.head.ref === repo.headBranch);
  if (!match) {
    return null;
  }
  const { data: pull } = await octokit.rest.pulls.get({
    owner: target.owner,
    repo: target.repo,
    pull_number: match.number,
  });
  return toSummary(pull);
}

/**
 * Finds the open PR whose head is this worktree's branch, or null when none
 * exists yet (→ the create state).
 *
 * The PR lives in the `origin` repo for an ordinary branch, but in `origin`'s
 * upstream parent when `origin` is a fork and the PR targets that parent — the
 * cross-fork flow that {@link listBaseRepoOptions}/{@link createPullRequest}
 * support. We try `origin` first (the common, cheap path), then fall back to the
 * upstream parent so a cross-fork PR doesn't drop the sidebar back to the create
 * view on refresh/poll.
 */
export async function findPullRequestForBranch(
  repo: GitHubRepoRef,
): Promise<PullRequestSummary | null> {
  const octokit = await client();
  const fromOrigin = await findPullInRepo(octokit, repo, { owner: repo.owner, repo: repo.repo });
  if (fromOrigin) {
    return fromOrigin;
  }
  const upstream = (await listBaseRepoOptions(repo)).find((target) => target.isUpstream);
  return upstream
    ? findPullInRepo(octokit, repo, { owner: upstream.owner, repo: upstream.repo })
    : null;
}

/** A repository a pull request can be opened against (the base-repository selector). */
export interface RepoTarget {
  owner: string;
  repo: string;
  defaultBranch: string;
  /** Whether this is the upstream parent of a fork (vs the origin repo itself). */
  isUpstream: boolean;
}

/** Octokit repo payload fields we read for the base-repository options. */
interface RepoLike {
  default_branch: string;
  fork: boolean;
  parent?: { owner: { login: string } | null; name: string; default_branch: string } | null;
}

/**
 * The repositories a PR from this worktree can target: always the `origin` repo
 * itself, plus its upstream parent when `origin` is a fork (so the user can open
 * a PR into the fork's source — GitHub's cross-fork flow). The origin repo is
 * listed first because the default base lives there (the parent worktree branch).
 */
export async function listBaseRepoOptions(repo: GitHubRepoRef): Promise<RepoTarget[]> {
  const octokit = await client();
  const { data } = await octokit.rest.repos.get({ owner: repo.owner, repo: repo.repo });
  const info = data as RepoLike;
  const options: RepoTarget[] = [
    { owner: repo.owner, repo: repo.repo, defaultBranch: info.default_branch, isUpstream: false },
  ];
  if (info.fork && info.parent?.owner) {
    options.push({
      owner: info.parent.owner.login,
      repo: info.parent.name,
      defaultBranch: info.parent.default_branch,
      isUpstream: true,
    });
  }
  return options;
}

/** Lists a repo's branch names (the base-branch dropdown), sorted alphabetically. */
export async function listBranches(target: { owner: string; repo: string }): Promise<string[]> {
  const octokit = await client();
  const branches = await octokit.paginate(octokit.rest.repos.listBranches, {
    owner: target.owner,
    repo: target.repo,
    per_page: 100,
  });
  return branches.map((branch) => branch.name).toSorted((a, b) => a.localeCompare(b));
}

/**
 * Opens a pull request. `base` selects the target repository **and** branch (the
 * merge-into target chosen in the UI); `head` is the worktree branch, qualified
 * with the origin owner (`owner:branch`) when the base repo differs — GitHub's
 * cross-fork head syntax.
 */
export async function createPullRequest(
  repo: GitHubRepoRef,
  base: { owner: string; repo: string; branch: string },
  input: { title: string; body: string; draft: boolean },
): Promise<PullRequestSummary> {
  const octokit = await client();
  const head = base.owner === repo.owner ? repo.headBranch : `${repo.owner}:${repo.headBranch}`;
  const { data } = await octokit.rest.pulls.create({
    owner: base.owner,
    repo: base.repo,
    title: input.title,
    body: input.body,
    head,
    base: base.branch,
    draft: input.draft,
  });
  return toSummary(data);
}

/** Fetches a single pull request by number. */
export async function getPullRequest(
  repo: GitHubRepoRef,
  prNumber: number,
): Promise<PullRequestSummary> {
  const octokit = await client();
  const { data } = await octokit.rest.pulls.get({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
  });
  return toSummary(data);
}

/** Lists the PR's conversation (issue) comments — read-only in v1. */
export async function listIssueComments(
  repo: GitHubRepoRef,
  prNumber: number,
): Promise<IssueComment[]> {
  const octokit = await client();
  const { data } = await octokit.rest.issues.listComments({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: prNumber,
  });
  return data.map((comment) => ({
    id: comment.id,
    body: comment.body ?? "",
    htmlUrl: comment.html_url,
    createdAt: comment.created_at,
    user: comment.user ? { login: comment.user.login, avatarUrl: comment.user.avatar_url } : null,
  }));
}

/** Posts a new conversation (issue) comment on the PR as the signed-in user. */
export async function createIssueComment(
  repo: GitHubRepoRef,
  prNumber: number,
  body: string,
): Promise<IssueComment> {
  const octokit = await client();
  const { data: comment } = await octokit.rest.issues.createComment({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: prNumber,
    body,
  });
  return {
    id: comment.id,
    body: comment.body ?? "",
    htmlUrl: comment.html_url,
    createdAt: comment.created_at,
    user: comment.user ? { login: comment.user.login, avatarUrl: comment.user.avatar_url } : null,
  };
}

/** GraphQL response shape for {@link listPullRequestCommits}. */
interface PullRequestCommitsResponse {
  repository: {
    pullRequest: {
      commits: {
        pageInfo: {
          endCursor: string | null;
          hasNextPage: boolean;
        };
        nodes: Array<{
          commit: {
            authors: {
              nodes: Array<{
                name: string;
                user: { login: string; avatarUrl: string } | null;
              }>;
            };
            committedDate: string;
            messageHeadline: string;
            oid: string;
            statusCheckRollup: { state: string } | null;
            url: string;
          };
        }>;
      };
    };
  };
}

const PULL_REQUEST_COMMITS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        commits(first: 100, after: $after) {
          pageInfo { endCursor hasNextPage }
          nodes {
            commit {
              authors(first: 10) {
                nodes {
                  name
                  user { login avatarUrl }
                }
              }
              committedDate
              messageHeadline
              oid
              statusCheckRollup { state }
              url
            }
          }
        }
      }
    }
  }
`;

/** Maps GitHub's GraphQL check-rollup state to the UI's compact status vocabulary. */
function toChecksState(state: string | null): ChecksStatus["state"] {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

/**
 * Lists commits in a PR with every Git author (including co-authors), its commit
 * time, diff URL, and CI rollup. GitHub exposes this richer commit metadata only
 * through GraphQL.
 */
export async function listPullRequestCommits(
  repo: GitHubRepoRef,
  prNumber: number,
): Promise<PullRequestCommit[]> {
  const octokit = await client();
  const commits: PullRequestCommit[] = [];
  let after: string | null = null;
  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- GitHub cursor pagination is sequential.
    const data: PullRequestCommitsResponse = await octokit.graphql<PullRequestCommitsResponse>(
      PULL_REQUEST_COMMITS_QUERY,
      {
        owner: repo.owner,
        repo: repo.repo,
        number: prNumber,
        after,
      },
    );
    const connection = data.repository.pullRequest.commits;
    commits.push(
      ...connection.nodes.map(({ commit }) => ({
        authors: commit.authors.nodes.map((author) => ({
          name: author.name,
          user: author.user ? { login: author.user.login, avatarUrl: author.user.avatarUrl } : null,
        })),
        committedAt: commit.committedDate,
        message: commit.messageHeadline,
        sha: commit.oid,
        status: toChecksState(commit.statusCheckRollup?.state ?? null),
        url: commit.url,
      })),
    );
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return commits;
}

/** Lists the files changed in a PR (the review file list). */
export async function listPullFiles(repo: GitHubRepoRef, prNumber: number): Promise<PullFile[]> {
  const octokit = await client();
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return files.map((file) => ({
    path: file.filename,
    oldPath: file.previous_filename ?? null,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  }));
}

/**
 * Lists the PR's submitted reviews (the parent of each set of inline comments),
 * newest first. A review with no summary body and no verdict (a bare
 * `COMMENTED` review that only carried inline comments) is dropped, since it has
 * nothing of its own to show.
 */
export async function listPullReviews(
  repo: GitHubRepoRef,
  prNumber: number,
): Promise<PullReview[]> {
  const octokit = await client();
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return reviews
    .filter((review) => (review.body ?? "").trim().length > 0 || review.state !== "COMMENTED")
    .map((review) => ({
      id: review.id,
      body: review.body ?? "",
      state: review.state as PullReview["state"],
      htmlUrl: review.html_url,
      submittedAt: review.submitted_at ?? null,
      user: review.user ? { login: review.user.login, avatarUrl: review.user.avatar_url } : null,
    }));
}

/** GraphQL response shape for {@link listReviewThreads}. */
interface ReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          id: string;
          isResolved: boolean;
          path: string;
          line: number | null;
          comments: {
            nodes: Array<{
              databaseId: number | null;
              body: string;
              createdAt: string;
              author: { login: string; avatarUrl: string } | null;
            }>;
          };
        }>;
      };
    };
  };
}

const REVIEW_THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            path
            line
            comments(first: 50) {
              nodes {
                databaseId
                body
                createdAt
                author { login avatarUrl }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Lists the PR's review threads with their resolved state via GraphQL — REST
 * exposes neither the thread node id (needed to resolve) nor `isResolved`, so
 * this single GraphQL call subsumes `pulls.listReviewComments` for the review UI.
 */
export async function listReviewThreads(
  repo: GitHubRepoRef,
  prNumber: number,
): Promise<ReviewThread[]> {
  const octokit = await client();
  const data = await octokit.graphql<ReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
    owner: repo.owner,
    repo: repo.repo,
    number: prNumber,
  });
  return data.repository.pullRequest.reviewThreads.nodes.map((thread) => ({
    id: thread.id,
    path: thread.path,
    line: thread.line,
    isResolved: thread.isResolved,
    comments: thread.comments.nodes.map((comment) => ({
      id: comment.databaseId ?? 0,
      body: comment.body,
      createdAt: comment.createdAt,
      user: comment.author
        ? { login: comment.author.login, avatarUrl: comment.author.avatarUrl }
        : null,
    })),
  }));
}

/** Marks a review thread resolved (GraphQL — REST can't resolve threads). */
export async function resolveReviewThread(threadId: string): Promise<void> {
  const octokit = await client();
  await octokit.graphql(
    `mutation ($id: ID!) {
      resolveReviewThread(input: { threadId: $id }) {
        thread { isResolved }
      }
    }`,
    { id: threadId },
  );
}

/** Marks a review thread unresolved (GraphQL — the inverse of {@link resolveReviewThread}). */
export async function unresolveReviewThread(threadId: string): Promise<void> {
  const octokit = await client();
  await octokit.graphql(
    `mutation ($id: ID!) {
      unresolveReviewThread(input: { threadId: $id }) {
        thread { isResolved }
      }
    }`,
    { id: threadId },
  );
}

/** Normalizes one check run into the status rendered by the checks dropdown. */
function checkRunState(run: {
  status: string;
  conclusion: string | null;
}): CheckStatusItem["state"] {
  if (run.status !== "completed") return "pending";
  if (run.conclusion === "success" || run.conclusion === "neutral" || run.conclusion === "skipped")
    return "success";
  return "failure";
}

/** Normalizes one legacy commit status for the checks dropdown. */
function commitStatusState(state: string): CheckStatusItem["state"] {
  if (state === "success") return "success";
  if (state === "failure" || state === "error") return "failure";
  return "pending";
}

interface ChecksCounts {
  passed: number;
  failed: number;
  pending: number;
}

function tallyItem(item: CheckStatusItem, counts: ChecksCounts): void {
  if (item.state === "success") counts.passed += 1;
  else if (item.state === "failure") counts.failed += 1;
  else counts.pending += 1;
}

/** Derives the rollup state from counts: failure > pending > success > none. */
function checksStateFromCounts(counts: ChecksCounts): ChecksStatus["state"] {
  const total = counts.passed + counts.failed + counts.pending;
  if (total === 0) {
    return "none";
  }
  if (counts.failed > 0) {
    return "failure";
  }
  if (counts.pending > 0) {
    return "pending";
  }
  return "success";
}

/** Summarizes CI checks + commit statuses for a ref (the merge card). */
export async function getChecksStatus(repo: GitHubRepoRef, ref: string): Promise<ChecksStatus> {
  const octokit = await client();
  const [checks, combined] = await Promise.all([
    octokit.rest.checks.listForRef({ owner: repo.owner, repo: repo.repo, ref, per_page: 100 }),
    octokit.rest.repos.getCombinedStatusForRef({ owner: repo.owner, repo: repo.repo, ref }),
  ]);

  const items: CheckStatusItem[] = [
    ...checks.data.check_runs.map((run) => ({
      name: run.name || "GitHub check",
      state: checkRunState(run),
      url: run.details_url ?? null,
    })),
    ...combined.data.statuses.map((status) => ({
      name: status.context || "Commit status",
      state: commitStatusState(status.state),
      url: status.target_url ?? null,
    })),
  ];
  const counts: ChecksCounts = { passed: 0, failed: 0, pending: 0 };
  for (const item of items) tallyItem(item, counts);

  return {
    state: checksStateFromCounts(counts),
    total: items.length,
    passed: counts.passed,
    failed: counts.failed,
    pending: counts.pending,
    items,
  };
}

/** Merges a pull request with the given strategy (default: a merge commit). */
export async function mergePullRequest(
  repo: GitHubRepoRef,
  prNumber: number,
  method: MergeMethod = "merge",
): Promise<void> {
  const octokit = await client();
  await octokit.rest.pulls.merge({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    merge_method: method,
  });
}
