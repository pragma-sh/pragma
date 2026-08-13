import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GitHubRepoRef } from "@pragma/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  browserOpenExternal,
  github,
  githubAbortMerge,
  githubMergeBaseBranch,
  githubMergeInProgress,
  workspace,
} = vi.hoisted(() => ({
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
  githubAbortMerge: vi.fn(),
  githubMergeBaseBranch: vi.fn(),
  githubMergeInProgress: vi.fn(),
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
vi.mock("@/lib/tauri", () => ({
  browserOpenExternal,
  githubAbortMerge,
  githubDeleteRemoteBranch: vi.fn(),
  githubMergeBaseBranch,
  githubMergeInProgress,
}));
vi.mock("@/state/workspace-context", () => ({ useWorkspace: () => workspace }));

import { ChecksSummary, ViewPullRequestView } from "./ViewPullRequestView";

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
  githubMergeBaseBranch.mockResolvedValue(true);
  githubMergeInProgress.mockResolvedValue(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

  it("replaces merge controls with conflict resolution", async () => {
    render(
      <ViewPullRequestView
        onChanged={vi.fn()}
        pr={{
          number: 1,
          title: "Conflicted",
          body: "",
          state: "open",
          htmlUrl: "https://github.com/acme/widget/pull/1",
          headRef: "feature",
          headSha: "a1b2c3d4e5f6",
          baseRef: "main",
          baseRepo: {
            owner: "upstream",
            repo: "widget",
            cloneUrl: "https://github.com/upstream/widget.git",
          },
          draft: false,
          merged: false,
          mergeable: false,
          user: null,
        }}
        repo={repo}
        worktreeId="worktree-1"
      />,
    );

    expect(await screen.findByText("Merge conflict")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This pull request conflicts with main. Resolve it by merging latest main into feature locally.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Merge pull request" })).not.toBeInTheDocument();
    const syncButton = screen.getByRole("button", { name: "Sync with Base Branch" });
    await waitFor(() => {
      expect(githubMergeInProgress).toHaveBeenCalledWith("worktree-1");
      expect(syncButton).toBeEnabled();
    });
    githubMergeInProgress.mockResolvedValue(true);
    fireEvent.click(syncButton);

    await waitFor(() => {
      expect(githubMergeBaseBranch).toHaveBeenCalledWith(
        "worktree-1",
        "main",
        "https://github.com/upstream/widget.git",
      );
    });
    expect(screen.getByRole("button", { name: "Abort Merge" })).toBeInTheDocument();
    expect(screen.getByText("Resolve the Merge Conflict and Commit")).toBeInTheDocument();
    githubMergeInProgress.mockResolvedValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Abort Merge" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Abort merge?");
    fireEvent.click(screen.getByRole("button", { name: "Abort merge" }));
    await waitFor(() => {
      expect(githubAbortMerge).toHaveBeenCalledWith("worktree-1");
    });
    // The confirm dialog animates out, and Radix keeps the page behind it
    // aria-hidden until it unmounts — so the button underneath only becomes
    // queryable once the close animation has finished.
    expect(
      await screen.findByRole("button", { name: "Sync with Base Branch" }),
    ).toBeInTheDocument();
  });
});

describe("ChecksSummary", () => {
  it("shows aggregate state circles and expands each GitHub check", async () => {
    render(
      <ChecksSummary
        checks={{
          state: "failure",
          total: 3,
          passed: 1,
          failed: 1,
          pending: 1,
          items: [
            { name: "build", state: "success", url: null },
            { name: "lint", state: "failure", url: null },
            { name: "test", state: "pending", url: null },
          ],
        }}
      />,
    );

    const trigger = screen.getByRole("button", { name: /1 of 3 checks failed/i });
    expect(trigger).toHaveTextContent("1 of 3 checks failed");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });

    expect(await screen.findByText("build")).toBeInTheDocument();
    expect(screen.getByText("lint")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
  });

  it("opens a check's external URL when selecting its status", async () => {
    render(
      <ChecksSummary
        checks={{
          state: "success",
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          items: [{ name: "Greptile review", state: "success", url: "https://app.greptile.com" }],
        }}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /all 1 checks passed/i }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByText("Greptile review"));

    expect(browserOpenExternal).toHaveBeenCalledWith("https://app.greptile.com");
  });

  it("does not open a URL for a check that has none", async () => {
    render(
      <ChecksSummary
        checks={{
          state: "pending",
          total: 1,
          passed: 0,
          failed: 0,
          pending: 1,
          items: [{ name: "test", state: "pending", url: null }],
        }}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /0\/1 checks complete/i }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByText("test"));

    expect(browserOpenExternal).not.toHaveBeenCalled();
  });
});
