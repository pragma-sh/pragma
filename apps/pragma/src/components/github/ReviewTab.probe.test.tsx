import type { Tab } from "@pragma/constants";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveReviewThread, state } = vi.hoisted(() => ({
  resolveReviewThread: vi.fn(async () => {}),
  state: { threadResolved: false },
}));

vi.mock("@/lib/tauri", () => ({
  githubRepoRef: vi.fn(async () => ({
    owner: "o",
    repo: "r",
    headBranch: "b",
    defaultBranch: "main",
  })),
  githubPrFileDiff: vi.fn(async () => ({ oldText: "a\n", newText: "a\nb\n", binary: false })),
}));

vi.mock("@/lib/github", () => ({
  getPullRequest: vi.fn(async () => ({ number: 1, title: "T", baseRef: "main", headRef: "b" })),
  listPullFiles: vi.fn(async () => [
    { path: "f.ts", oldPath: null, status: "modified", additions: 1, deletions: 0 },
  ]),
  listPullReviews: vi.fn(async () => [
    {
      id: 7,
      body: "Please address the comments",
      state: "CHANGES_REQUESTED",
      htmlUrl: "",
      submittedAt: "",
      user: { login: "rev", avatarUrl: "" },
    },
  ]),
  listReviewThreads: vi.fn(async () => [
    {
      id: "thr1",
      path: "f.ts",
      line: 2,
      isResolved: state.threadResolved,
      comments: [{ id: 1, body: "hi", createdAt: "", user: { login: "u", avatarUrl: "" } }],
    },
  ]),
  resolveReviewThread,
}));

vi.mock("@/components/github/ViewPullRequestView", () => ({
  ActorAvatar: () => <div data-testid="avatar" />,
}));

vi.mock("@/components/github/GitHubMarkdown", () => ({
  GitHubMarkdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

import { ReviewTab } from "./ReviewTab";

const tab = { worktreeId: "w1", prNumber: 1 } as unknown as Tab;

describe("ReviewTab interactions", () => {
  beforeEach(() => {
    state.threadResolved = false;
    resolveReviewThread.mockClear();
  });

  it("collapses the inline thread on click", async () => {
    render(<ReviewTab tab={tab} />);
    // comment body visible initially
    await waitFor(() => expect(screen.getByText("hi")).toBeInTheDocument());
    const toggle = screen.getByText(/Line 2/);
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByText("hi")).not.toBeInTheDocument());
  });

  it("shows the parent review summary and verdict", async () => {
    const { container } = render(<ReviewTab tab={tab} />);
    const view = within(container);
    await waitFor(() => expect(view.getByText("Please address the comments")).toBeInTheDocument());
    expect(view.getByText("requested changes")).toBeInTheDocument();
  });

  it("resolves the thread on click", async () => {
    render(<ReviewTab tab={tab} />);
    const btn = await screen.findByRole("button", { name: /Resolve/ });
    fireEvent.click(btn);
    await waitFor(() => expect(resolveReviewThread).toHaveBeenCalledWith("thr1"));
  });
});
