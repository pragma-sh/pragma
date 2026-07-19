import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GitHubRepoRef } from "@pragma/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { browserOpenExternal, github, workspace } = vi.hoisted(() => ({
  browserOpenExternal: vi.fn(),
  github: {
    createIssueComment: vi.fn(),
    getChecksStatus: vi.fn(),
    listIssueComments: vi.fn(),
    listPullFiles: vi.fn(),
    listPullRequestCommits: vi.fn(),
    listReviewThreads: vi.fn(),
    mergePullRequest: vi.fn(),
  },
  workspace: { deleteWorktree: vi.fn(), openReviewTab: vi.fn() },
}));

vi.mock("@/components/github/GitHubMarkdown", () => ({
  GitHubMarkdown: ({ children }: { children: string }) => <>{children}</>,
}));
vi.mock("@/components/github/MarkdownEditor", () => ({
  MarkdownEditor: () => <textarea aria-label="Comment" />,
}));
vi.mock("@/components/right-sidebar/ChangeGroup", () => ({
  ChangeGroup: () => null,
}));
vi.mock("@/lib/github", () => github);
vi.mock("@/lib/tauri", () => ({ browserOpenExternal, githubDeleteRemoteBranch: vi.fn() }));
vi.mock("@/state/workspace-context", () => ({ useWorkspace: () => workspace }));

import { ViewPullRequestView } from "./ViewPullRequestView";

const repo: GitHubRepoRef = {
  owner: "acme",
  repo: "widget",
  defaultBranch: "main",
  headBranch: "feature",
  parentBranch: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  github.getChecksStatus.mockResolvedValue({ state: "none", total: 0, passed: 0, failed: 0 });
  github.listIssueComments.mockResolvedValue([
    {
      id: 1,
      body: "Please revise this.",
      htmlUrl: "https://github.com/acme/widget/pull/1#issuecomment-1",
      createdAt: "2026-06-24T12:01:00Z",
      user: { login: "reviewer", avatarUrl: "https://avatars/reviewer" },
    },
  ]);
  github.listPullRequestCommits.mockResolvedValue([
    {
      authors: [{ name: "Octo Cat", user: { login: "octo", avatarUrl: "https://avatars/octo" } }],
      committedAt: "2026-06-24T12:00:00Z",
      message: "feat: commit timeline",
      sha: "a1b2c3d4e5f6",
      status: "success",
      url: "https://github.com/acme/widget/commit/a1b2c3d4e5f6",
    },
  ]);
  github.listPullFiles.mockResolvedValue([]);
  github.listReviewThreads.mockResolvedValue([]);
});

describe("ViewPullRequestView", () => {
  it("places commits by commit time and opens their GitHub diff", async () => {
    render(
      <ViewPullRequestView
        onChanged={vi.fn()}
        pr={{
          number: 1,
          title: "Timeline",
          body: "",
          state: "open",
          htmlUrl: "https://github.com/acme/widget/pull/1",
          headRef: "feature",
          headSha: "a1b2c3d4e5f6",
          baseRef: "main",
          draft: false,
          merged: false,
          mergeable: true,
          user: null,
        }}
        repo={repo}
        worktreeId="worktree-1"
      />,
    );

    const commitMessage = await screen.findByText("feat: commit timeline");
    const comment = screen.getByText("Please revise this.");
    expect(
      commitMessage.compareDocumentPosition(comment) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(commitMessage.closest("button")!);
    await waitFor(() => {
      expect(browserOpenExternal).toHaveBeenCalledWith(
        "https://github.com/acme/widget/commit/a1b2c3d4e5f6",
      );
    });
  });
});
