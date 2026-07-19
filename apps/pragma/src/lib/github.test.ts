import type { GitHubRepoRef } from "@pragma/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { octokit, githubToken } = vi.hoisted(() => ({
  octokit: {
    rest: {
      pulls: { list: vi.fn(), create: vi.fn(), get: vi.fn(), merge: vi.fn() },
      issues: { listComments: vi.fn(), createComment: vi.fn() },
      checks: { listForRef: vi.fn() },
      repos: { getCombinedStatusForRef: vi.fn(), get: vi.fn(), listBranches: vi.fn() },
    },
    graphql: vi.fn(),
    paginate: vi.fn(),
  },
  githubToken: vi.fn(),
}));

// A constructor function so `new Octokit()` is constructable; returning `octokit`
// from it makes `new` yield our shared mock instance.
function MockOctokit() {
  return octokit;
}
vi.mock("octokit", () => ({ Octokit: MockOctokit }));
vi.mock("@/lib/tauri", () => ({ githubToken: (...args: unknown[]) => githubToken(...args) }));

import {
  GitHubAuthError,
  createIssueComment,
  createPullRequest,
  findPullRequestForBranch,
  getChecksStatus,
  listBaseRepoOptions,
  listReviewThreads,
  resetGitHubClient,
} from "./github";

const repo: GitHubRepoRef = {
  owner: "acme",
  repo: "widget",
  defaultBranch: "main",
  headBranch: "feature",
  parentBranch: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetGitHubClient();
  githubToken.mockResolvedValue("token-123");
});

describe("client auth", () => {
  it("throws GitHubAuthError when no token is stored", async () => {
    githubToken.mockResolvedValue(null);
    await expect(findPullRequestForBranch(repo)).rejects.toBeInstanceOf(GitHubAuthError);
  });
});

describe("findPullRequestForBranch", () => {
  beforeEach(() => {
    // The upstream fallback discovers base repos via `repos.get`; default to a
    // non-fork so only the origin repo is searched.
    octokit.rest.repos.get.mockResolvedValue({
      data: { default_branch: "main", fork: false, parent: null },
    });
  });

  it("returns null when no open PR matches the branch", async () => {
    octokit.rest.pulls.list.mockResolvedValue({ data: [] });
    octokit.paginate.mockResolvedValue([]);
    expect(await findPullRequestForBranch(repo)).toBeNull();
    expect(octokit.rest.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ head: "acme:feature", state: "open" }),
    );
  });

  it("falls back to scanning open PRs when the head filter lags", async () => {
    // The head-filtered list is eventually consistent and can miss a just-opened
    // PR; the unfiltered scan must still find it by head ref.
    octokit.rest.pulls.list.mockResolvedValue({ data: [] });
    octokit.paginate.mockResolvedValue([
      {
        number: 7,
        title: "Other",
        body: "",
        state: "open",
        html_url: "https://github.com/acme/widget/pull/7",
        head: { ref: "unrelated", sha: "zzz" },
        base: { ref: "main" },
        user: null,
      },
      {
        number: 99,
        title: "Mine",
        body: "",
        state: "open",
        html_url: "https://github.com/acme/widget/pull/99",
        head: { ref: "feature", sha: "abc" },
        base: { ref: "main" },
        user: null,
      },
    ]);
    const pr = await findPullRequestForBranch(repo);
    expect(pr).toMatchObject({ number: 99, headRef: "feature" });
  });

  it("returns null when neither the filter nor the scan matches", async () => {
    octokit.rest.pulls.list.mockResolvedValue({ data: [] });
    octokit.paginate.mockResolvedValue([]);
    expect(await findPullRequestForBranch(repo)).toBeNull();
  });

  it("finds a PR opened against the upstream parent when origin is a fork", async () => {
    // Origin is a fork; its parent is `upstream/widget`.
    octokit.rest.repos.get.mockResolvedValue({
      data: {
        default_branch: "dev",
        fork: true,
        parent: { owner: { login: "upstream" }, name: "widget", default_branch: "main" },
      },
    });
    // Origin has no matching PR (filter + scan empty); the upstream parent does.
    octokit.rest.pulls.list.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({
      data: [
        {
          number: 5,
          title: "Cross-fork",
          body: "",
          state: "open",
          html_url: "https://github.com/upstream/widget/pull/5",
          head: { ref: "feature", sha: "abc" },
          base: { ref: "main" },
          user: null,
        },
      ],
    });
    octokit.paginate.mockResolvedValue([]);
    const pr = await findPullRequestForBranch(repo);
    expect(pr).toMatchObject({ number: 5, headRef: "feature" });
    expect(octokit.rest.pulls.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ owner: "upstream", repo: "widget", head: "acme:feature" }),
    );
  });

  it("maps the first matching PR to a summary", async () => {
    octokit.rest.pulls.list.mockResolvedValue({
      data: [
        {
          number: 42,
          title: "Add subtab",
          body: "body",
          state: "open",
          html_url: "https://github.com/acme/widget/pull/42",
          draft: false,
          head: { ref: "feature", sha: "abc" },
          base: { ref: "main" },
          user: { login: "octo", avatar_url: "https://avatars/octo" },
        },
      ],
    });
    const pr = await findPullRequestForBranch(repo);
    expect(pr).toMatchObject({ number: 42, headRef: "feature", baseRef: "main" });
    expect(pr?.user).toEqual({ login: "octo", avatarUrl: "https://avatars/octo" });
  });
});

describe("getChecksStatus", () => {
  it("reports success when every check and status passed", async () => {
    octokit.rest.checks.listForRef.mockResolvedValue({
      data: {
        check_runs: [
          {
            name: "build",
            status: "completed",
            conclusion: "success",
            details_url: "https://github.com/acme/widget/actions/1",
          },
        ],
      },
    });
    octokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({
      data: { statuses: [{ context: "coverage", state: "success", target_url: null }] },
    });
    expect(await getChecksStatus(repo, "abc")).toEqual({
      state: "success",
      total: 2,
      passed: 2,
      failed: 0,
      pending: 0,
      items: [
        {
          name: "build",
          state: "success",
          url: "https://github.com/acme/widget/actions/1",
        },
        { name: "coverage", state: "success", url: null },
      ],
    });
  });

  it("reports failure when any check failed", async () => {
    octokit.rest.checks.listForRef.mockResolvedValue({
      data: {
        check_runs: [
          { status: "completed", conclusion: "success" },
          { status: "completed", conclusion: "failure" },
        ],
      },
    });
    octokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({ data: { statuses: [] } });
    expect(await getChecksStatus(repo, "abc")).toMatchObject({ state: "failure", failed: 1 });
  });

  it("reports pending while a check is still running", async () => {
    octokit.rest.checks.listForRef.mockResolvedValue({
      data: { check_runs: [{ status: "in_progress", conclusion: null }] },
    });
    octokit.rest.repos.getCombinedStatusForRef.mockResolvedValue({ data: { statuses: [] } });
    expect(await getChecksStatus(repo, "abc")).toMatchObject({ state: "pending" });
  });
});

describe("listBaseRepoOptions", () => {
  it("returns just the origin repo when it is not a fork", async () => {
    octokit.rest.repos.get.mockResolvedValue({
      data: { default_branch: "main", fork: false, parent: null },
    });
    const options = await listBaseRepoOptions(repo);
    expect(options).toEqual([
      { owner: "acme", repo: "widget", defaultBranch: "main", isUpstream: false },
    ]);
  });

  it("adds the upstream parent when the origin is a fork", async () => {
    octokit.rest.repos.get.mockResolvedValue({
      data: {
        default_branch: "dev",
        fork: true,
        parent: { owner: { login: "upstream" }, name: "widget", default_branch: "main" },
      },
    });
    const options = await listBaseRepoOptions(repo);
    expect(options).toEqual([
      { owner: "acme", repo: "widget", defaultBranch: "dev", isUpstream: false },
      { owner: "upstream", repo: "widget", defaultBranch: "main", isUpstream: true },
    ]);
  });
});

describe("createPullRequest", () => {
  beforeEach(() => {
    octokit.rest.pulls.create.mockResolvedValue({
      data: {
        number: 12,
        title: "t",
        body: "",
        state: "open",
        html_url: "https://github.com/acme/widget/pull/12",
        head: { ref: "feature", sha: "abc" },
        base: { ref: "release" },
        user: null,
      },
    });
  });

  it("uses a bare head ref when base and head share the owner", async () => {
    await createPullRequest(
      repo,
      { owner: "acme", repo: "widget", branch: "release" },
      { title: "t", body: "b", draft: false },
    );
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "widget", base: "release", head: "feature" }),
    );
  });

  it("qualifies the head with the origin owner for a cross-fork PR", async () => {
    await createPullRequest(
      repo,
      { owner: "upstream", repo: "widget", branch: "main" },
      { title: "t", body: "b", draft: true },
    );
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "upstream",
        repo: "widget",
        base: "main",
        head: "acme:feature",
        draft: true,
      }),
    );
  });
});

describe("listReviewThreads", () => {
  it("flattens the GraphQL thread/comment shape", async () => {
    octokit.graphql.mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "T1",
                isResolved: false,
                path: "src/a.ts",
                line: 12,
                comments: {
                  nodes: [
                    {
                      databaseId: 7,
                      body: "nit",
                      createdAt: "2026-01-01",
                      author: { login: "octo", avatarUrl: "https://avatars/octo" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const threads = await listReviewThreads(repo, 42);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: "T1", path: "src/a.ts", line: 12, isResolved: false });
    expect(threads[0]?.comments[0]).toEqual({
      id: 7,
      body: "nit",
      createdAt: "2026-01-01",
      user: { login: "octo", avatarUrl: "https://avatars/octo" },
    });
  });
});

describe("createIssueComment", () => {
  it("posts the comment and maps the response to an IssueComment", async () => {
    octokit.rest.issues.createComment.mockResolvedValue({
      data: {
        id: 99,
        body: "looks good",
        html_url: "https://github.com/acme/widget/pull/42#issuecomment-99",
        created_at: "2026-06-24",
        user: { login: "octo", avatar_url: "https://avatars/octo" },
      },
    });
    const comment = await createIssueComment(repo, 42, "looks good");
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widget",
      issue_number: 42,
      body: "looks good",
    });
    expect(comment).toEqual({
      id: 99,
      body: "looks good",
      htmlUrl: "https://github.com/acme/widget/pull/42#issuecomment-99",
      createdAt: "2026-06-24",
      user: { login: "octo", avatarUrl: "https://avatars/octo" },
    });
  });
});
