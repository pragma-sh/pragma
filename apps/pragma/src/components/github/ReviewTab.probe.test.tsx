import type { Tab } from "@pragma/constants";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearFixItComments } from "@/state/fix-it-store";
import { clearReviewFocus, requestReviewFocus } from "@/state/review-focus-store";

const { listPullReviews, resolveReviewThread, state } = vi.hoisted(() => ({
  listPullReviews: vi.fn(),
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

vi.mock("@/plugins/agents", () => ({
  // The fix dialogs load agents via `useAgentSelection` once opened.
  usePluginAgents: vi.fn(() => []),
}));

vi.mock("@/lib/github", () => ({
  getPullRequest: vi.fn(async () => ({ number: 1, title: "T", baseRef: "main", headRef: "b" })),
  listPullFiles: vi.fn(async () => [
    { path: "f.ts", oldPath: null, status: "modified", additions: 1, deletions: 0 },
  ]),
  listPullReviews,
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
vi.mock("@/components/github/PullRequestStackCard", () => ({
  PullRequestStackCard: () => null,
}));

// The fix dialogs mount only when open; workspace context is still needed for the open case.
vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({
    selectedProjectId: "p",
    refreshProject: vi.fn(),
    startSession: vi.fn(),
  }),
}));

import { ReviewTab } from "./ReviewTab";

const tab = { worktreeId: "w1", prNumber: 1 } as unknown as Tab;

describe("ReviewTab interactions", () => {
  beforeEach(() => {
    state.threadResolved = false;
    resolveReviewThread.mockClear();
    listPullReviews.mockReset();
    listPullReviews.mockResolvedValue([
      {
        id: 7,
        body: "Please address the comments",
        state: "CHANGES_REQUESTED",
        htmlUrl: "",
        submittedAt: "",
        user: { login: "rev", avatarUrl: "" },
      },
    ]);
    clearFixItComments(1);
  });

  // Each test renders a fresh ReviewTab; without this the CodeMirror-portaled
  // comment cards from prior renders linger and duplicate role queries.
  afterEach(cleanup);

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

  it("shows inline comments before review summaries finish loading", async () => {
    let finishReviews: (() => void) | undefined;
    listPullReviews.mockReturnValue(
      new Promise((resolve) => {
        finishReviews = () => resolve([]);
      }),
    );

    render(<ReviewTab tab={tab} />);

    expect(await screen.findByText("hi")).toBeInTheDocument();
    act(() => finishReviews?.());
  });

  it("resolves the thread on click", async () => {
    render(<ReviewTab tab={tab} />);
    const btn = await screen.findByRole("button", { name: /Resolve/ });
    fireEvent.click(btn);
    await waitFor(() => expect(resolveReviewThread).toHaveBeenCalledWith("thr1"));
  });

  it("flags a comment to the fix it list, enabling the address button", async () => {
    render(<ReviewTab tab={tab} />);
    const addBtn = await screen.findByRole("button", { name: /Add to fix it list/ });
    // The top "Address fix it list" button starts disabled (empty list).
    expect(screen.getByRole("button", { name: /Address fix it list/ })).toBeDisabled();
    fireEvent.click(addBtn);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /On fix it list/ })).toBeInTheDocument(),
    );
    const addressButton = screen.getByRole("button", { name: /Address fix it list/ });
    expect(addressButton).toBeEnabled();
    fireEvent.click(addressButton);
    const commitAndPush = await screen.findByRole("switch", { name: "Commit and push" });
    expect(commitAndPush).not.toBeChecked();
    fireEvent.click(commitAndPush);
    expect(commitAndPush).toBeChecked();
  });

  it("opens the single-comment fix dialog from the Fix button", async () => {
    render(<ReviewTab tab={tab} />);
    const fixBtn = await screen.findByRole("button", { name: /^Fix$/ });
    fireEvent.click(fixBtn);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Fix review comment" })).toBeInTheDocument(),
    );
  });

  it("scrolls to a comment when the toolbar next arrow is clicked", async () => {
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const { container } = render(<ReviewTab tab={tab} />);
    // The toolbar reports the single thread as one navigable comment.
    await waitFor(() => expect(screen.getByText("1 comment")).toBeInTheDocument());
    // The inline comment mounts into the diff via a portal; wait for its node.
    await waitFor(() =>
      expect(container.querySelector('[data-review-comment="thr1"]')).not.toBeNull(),
    );
    // Nothing visited yet: "previous" is disabled, "next" can reach the comment.
    expect(screen.getByRole("button", { name: "Previous comment" })).toBeDisabled();
    const next = screen.getByRole("button", { name: "Next comment" });
    expect(next).toBeEnabled();
    fireEvent.click(next);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    // On the only comment now: both ends are reached, so both arrows disable.
    expect(screen.getByRole("button", { name: "Next comment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous comment" })).toBeDisabled();
    scrollIntoView.mockRestore();
  });

  it("redirects wheel scrolling to the review container until the diff is clicked", async () => {
    const { container } = render(<ReviewTab tab={tab} />);
    await screen.findByRole("button", { name: /Resolve/ });
    const pane = container.querySelector<HTMLElement>(".h-80");
    expect(pane).not.toBeNull();
    // Not engaged → the diff must not trap the wheel; the default scroll is
    // cancelled so the parent review container scrolls instead.
    expect(fireEvent.wheel(pane as HTMLElement, { deltaY: 40 })).toBe(false);
    // Clicking into the diff engages it → it keeps its own scroll.
    fireEvent.pointerDown(pane as HTMLElement);
    expect(fireEvent.wheel(pane as HTMLElement, { deltaY: 40 })).toBe(true);
  });

  it("scrolls a file into view when its focus is requested", async () => {
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    clearReviewFocus(1);
    render(<ReviewTab tab={tab} />);
    // Wait until the file section has rendered (the resolve button only appears
    // once the data is ready) before requesting focus.
    await screen.findByRole("button", { name: /Resolve/ });
    act(() => requestReviewFocus(1, "f.ts"));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockRestore();
  });
});
