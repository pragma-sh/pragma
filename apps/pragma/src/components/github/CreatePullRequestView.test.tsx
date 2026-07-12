import type { KeyboardEvent } from "react";

import type { BranchSyncStatus, GitHubRepoRef, WorktreeChanges } from "@pragma/constants";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const githubDefaultPrTitle = vi.fn();
const githubFetchAndSync = vi.fn();
const githubPushBranch = vi.fn();
const worktreeChanges = vi.fn();
const aiGeneratePullRequestDraft = vi.fn();
const createPullRequest = vi.fn();
const listBaseRepoOptions = vi.fn();
const listBranches = vi.fn();
let aiAvailableMock = false;

vi.mock("@/lib/tauri", () => ({
  aiGeneratePullRequestDraft: (...a: unknown[]) => aiGeneratePullRequestDraft(...a),
  githubDefaultPrTitle: (...a: unknown[]) => githubDefaultPrTitle(...a),
  githubFetchAndSync: (...a: unknown[]) => githubFetchAndSync(...a),
  githubPushBranch: (...a: unknown[]) => githubPushBranch(...a),
  worktreeChanges: (...a: unknown[]) => worktreeChanges(...a),
}));
vi.mock("@/state/ai-context", () => ({
  useAi: () => ({ available: aiAvailableMock }),
}));
vi.mock("@/lib/github", () => ({
  createPullRequest: (...a: unknown[]) => createPullRequest(...a),
  listBaseRepoOptions: (...a: unknown[]) => listBaseRepoOptions(...a),
  listBranches: (...a: unknown[]) => listBranches(...a),
}));
// The TipTap editor pulls in canvas/lowlight; a plain textarea is enough here.
vi.mock("@/components/github/MarkdownEditor", () => ({
  MarkdownEditor: ({
    onChange,
    onKeyDown,
    value,
  }: {
    onChange: (value: string) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    value: string;
  }) => (
    <textarea
      aria-label="Body"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      value={value}
    />
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CreatePullRequestView } from "./CreatePullRequestView";

const repo: GitHubRepoRef = {
  owner: "acme",
  repo: "widget",
  defaultBranch: "main",
  headBranch: "feature",
  parentBranch: "develop",
};

function sync(overrides: Partial<BranchSyncStatus> = {}): BranchSyncStatus {
  return { branch: "feature", ahead: 1, behind: 0, hasUpstream: true, ...overrides };
}

function changes(overrides: Partial<WorktreeChanges> = {}): WorktreeChanges {
  return { staged: [], unstaged: [], committed: [], ...overrides };
}

async function renderReady() {
  const onCreated = vi.fn();
  render(<CreatePullRequestView onCreated={onCreated} repo={repo} worktreeId="wt1" />);
  // Wait for the default title to seed and the base target to resolve so the
  // submit buttons enable.
  await waitFor(() =>
    expect(screen.getByLabelText("Pull request title")).toHaveValue("Seed title"),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Create pull request" })).toBeEnabled(),
  );
  return onCreated;
}

describe("CreatePullRequestView pre-flight", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    aiAvailableMock = false;
    githubDefaultPrTitle.mockResolvedValue("Seed title");
    githubPushBranch.mockResolvedValue(undefined);
    aiGeneratePullRequestDraft.mockResolvedValue({
      title: "Generated PR title",
      body: "Generated PR body",
    });
    createPullRequest.mockResolvedValue({ number: 7 });
    listBaseRepoOptions.mockResolvedValue([
      { owner: "acme", repo: "widget", defaultBranch: "main", isUpstream: false },
    ]);
    listBranches.mockResolvedValue(["develop", "main"]);
  });

  it("blocks the PR when the branch is behind its upstream", async () => {
    githubFetchAndSync.mockResolvedValue(sync({ behind: 3 }));
    worktreeChanges.mockResolvedValue(changes());
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));

    await waitFor(() => expect(screen.getByText("Branch is behind")).toBeInTheDocument());
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("warns on a dirty worktree, then creates after confirmation", async () => {
    githubFetchAndSync.mockResolvedValue(sync({ behind: 0 }));
    worktreeChanges.mockResolvedValue(
      changes({
        staged: [
          {
            path: "a.ts",
            oldPath: null,
            status: "modified",
            side: "staged",
            additions: 1,
            deletions: 0,
          },
        ],
      }),
    );
    const onCreated = await renderReady();

    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    await waitFor(() => expect(screen.getByText("Uncommitted changes")).toBeInTheDocument());
    expect(createPullRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create anyway" }));
    await waitFor(() => expect(createPullRequest).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalled();
  });

  it("pushes the branch first when it has no upstream", async () => {
    githubFetchAndSync.mockResolvedValue(sync({ behind: 0, hasUpstream: false }));
    worktreeChanges.mockResolvedValue(changes());
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    await waitFor(() => expect(createPullRequest).toHaveBeenCalledTimes(1));
    expect(githubPushBranch).toHaveBeenCalledWith("wt1");
  });

  it("defaults the base to the parent worktree branch", async () => {
    githubFetchAndSync.mockResolvedValue(sync({ behind: 0 }));
    worktreeChanges.mockResolvedValue(changes());
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    await waitFor(() => expect(createPullRequest).toHaveBeenCalledTimes(1));
    // parentBranch ("develop") is present in the branch list, so it wins over the
    // repo default branch as the base.
    expect(createPullRequest).toHaveBeenCalledWith(
      repo,
      { owner: "acme", repo: "widget", branch: "develop" },
      expect.objectContaining({ draft: false }),
    );
  });

  it("generates a PR title and body from Shift+Tab in the title field", async () => {
    aiAvailableMock = true;
    await renderReady();

    fireEvent.keyDown(screen.getByLabelText("Pull request title"), {
      key: "Tab",
      shiftKey: true,
    });

    await waitFor(() => expect(aiGeneratePullRequestDraft).toHaveBeenCalledWith("wt1"));
    expect(screen.getByLabelText("Pull request title")).toHaveValue("Generated PR title");
    expect(screen.getByLabelText("Body")).toHaveValue("Generated PR body");
  });

  it("generates a PR title and body from Shift+Tab in the body editor", async () => {
    aiAvailableMock = true;
    await renderReady();

    fireEvent.keyDown(screen.getByLabelText("Body"), { key: "Tab", shiftKey: true });

    await waitFor(() => expect(aiGeneratePullRequestDraft).toHaveBeenCalledWith("wt1"));
    expect(screen.getByLabelText("Pull request title")).toHaveValue("Generated PR title");
    expect(screen.getByLabelText("Body")).toHaveValue("Generated PR body");
  });

  it("restores an unfinished form for its worktree after leaving the PR tab", async () => {
    await renderReady();
    fireEvent.change(screen.getByLabelText("Pull request title"), {
      target: { value: "Saved title" },
    });
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Saved body" } });

    cleanup();
    render(<CreatePullRequestView onCreated={vi.fn()} repo={repo} worktreeId="wt1" />);

    expect(screen.getByLabelText("Pull request title")).toHaveValue("Saved title");
    expect(screen.getByLabelText("Body")).toHaveValue("Saved body");
  });
});
