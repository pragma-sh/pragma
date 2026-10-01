import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GitHubRepoRef } from "@pragma-sh/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PullRequestSummary } from "@/lib/github";
import type { MergeConflictProgress, MergeConflictResolution } from "@/lib/tauri";

const { ai, system1, tauri, toast, workspace } = vi.hoisted(() => ({
  ai: { available: true },
  workspace: { remoteWorktrees: {} as Record<string, boolean> },
  system1: {
    current: { configured: true, baseUrl: "", model: "" } as { configured: boolean } | null,
  },
  tauri: {
    aiCommitMergeResolution: vi.fn(),
    aiResolveMergeConflicts: vi.fn(),
    githubAbortMerge: vi.fn(),
    githubMergeBaseBranch: vi.fn(),
    githubMergeInProgress: vi.fn(),
    githubPushBranch: vi.fn(),
    githubUnmergedPaths: vi.fn(),
  },
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/tauri", () => tauri);
vi.mock("@/state/ai-context", () => ({ useAi: () => ai }));
vi.mock("@/state/workspace-context", () => ({ useWorkspace: () => workspace }));
vi.mock("@/state/system1", () => ({ useSystem1Status: () => system1.current }));

import { MergeConflictControls } from "./MergeConflictControls";

const repo: GitHubRepoRef = {
  owner: "acme",
  repo: "widget",
  defaultBranch: "main",
  headBranch: "feature",
  parentBranch: null,
};

const pr = {
  number: 1,
  title: "Add feature",
  body: "Why this matters",
  state: "open",
  htmlUrl: "https://github.com/acme/widget/pull/1",
  headRef: "feature",
  headSha: "abc",
  baseRef: "main",
  baseRepo: null,
  draft: false,
  merged: false,
  mergeable: false,
  user: null,
} as unknown as PullRequestSummary;

/** Git state the mocks report: `unmerged` is read only while a merge is running. */
function mergeState(inProgress: boolean, unmerged: string[]): void {
  tauri.githubMergeInProgress.mockResolvedValue(inProgress);
  tauri.githubUnmergedPaths.mockResolvedValue(unmerged);
}

function renderControls() {
  const onChanged = vi.fn();
  render(<MergeConflictControls onChanged={onChanged} pr={pr} repo={repo} worktreeId="wt" />);
  return onChanged;
}

beforeEach(() => {
  vi.clearAllMocks();
  ai.available = true;
  system1.current = { configured: true };
  workspace.remoteWorktrees = {};
});

afterEach(cleanup);

describe("MergeConflictControls", () => {
  it("hides AI resolution without built-in AI or a System 1 model", async () => {
    mergeState(false, []);
    system1.current = { configured: false };
    renderControls();
    expect(await screen.findByRole("button", { name: "Sync with Base Branch" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Resolve Merge Conflicts/ })).toBeNull();
  });

  it("offers AI resolution above sync, and syncs first when no merge is running", async () => {
    mergeState(false, []);
    tauri.githubMergeBaseBranch.mockResolvedValue(true);
    let progress: ((event: MergeConflictProgress) => void) | undefined;
    let finish: ((result: MergeConflictResolution) => void) | undefined;
    tauri.aiResolveMergeConflicts.mockImplementation(
      (_id: string, _pr: unknown, onProgress: typeof progress) => {
        progress = onProgress;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    renderControls();

    const buttons = await screen.findAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Resolve Merge Conflicts",
      "Sync with Base Branch",
    ]);
    await waitFor(() => expect(buttons[0]).toBeEnabled());
    fireEvent.click(buttons[0]!);

    await waitFor(() =>
      expect(tauri.aiResolveMergeConflicts).toHaveBeenCalledWith(
        "wt",
        { title: "Add feature", body: "Why this matters", headRef: "feature", baseRef: "main" },
        expect.any(Function),
      ),
    );
    expect(tauri.githubMergeBaseBranch).toHaveBeenCalledWith("wt", "main", null);
    expect(screen.getByRole("button", { name: "Resolving with System 1…" })).toBeDisabled();

    progress?.({ type: "progress", phase: "verifying", path: "src/a.ts" });
    expect(await screen.findByRole("button", { name: "Verifying results…" })).toBeDisabled();

    mergeState(true, []);
    finish?.({
      files: [
        { path: "src/a.ts", status: "resolved", method: "verified", escalation: "x", hunks: [] },
      ],
      remaining: [],
    });
    expect(await screen.findByRole("button", { name: "Commit and Push Fixes" })).toBeEnabled();
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("1 verified by AI"));
  });

  it("stays available after syncing leaves conflicts", async () => {
    mergeState(true, ["src/a.ts"]);
    renderControls();
    expect(await screen.findByRole("button", { name: "Resolve Merge Conflicts" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Abort Merge" })).toBeInTheDocument();
  });

  it("commits with the merge-conflict message and pushes", async () => {
    mergeState(true, []);
    tauri.aiCommitMergeResolution.mockResolvedValue("fix: resolve merge conflicts with main");
    tauri.githubPushBranch.mockResolvedValue(undefined);
    const onChanged = renderControls();

    fireEvent.click(await screen.findByRole("button", { name: "Commit and Push Fixes" }));

    await waitFor(() => expect(tauri.githubPushBranch).toHaveBeenCalledWith("wt"));
    expect(tauri.aiCommitMergeResolution).toHaveBeenCalledWith("wt", "main", "feature");
    expect(onChanged).toHaveBeenCalled();
  });

  it("offers no AI action on a remote worktree, even once conflicts are resolved", async () => {
    workspace.remoteWorktrees = { wt: true };
    mergeState(true, []);
    renderControls();
    expect(await screen.findByRole("button", { name: "Abort Merge" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Commit and Push Fixes/ })).toBeNull();
  });

  it("leaves the commit to the user without built-in AI", async () => {
    ai.available = false;
    mergeState(true, []);
    renderControls();
    expect(await screen.findByText(/Commit the merge, then push/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Commit and Push Fixes/ })).toBeNull();
  });

  it("retries only the push after a push fails following a successful commit", async () => {
    mergeState(true, []);
    tauri.aiCommitMergeResolution.mockResolvedValue("fix: resolve merge conflicts with main");
    tauri.githubPushBranch.mockRejectedValueOnce(new Error("network down"));
    tauri.githubPushBranch.mockResolvedValueOnce(undefined);
    const onChanged = renderControls();

    fireEvent.click(await screen.findByRole("button", { name: "Commit and Push Fixes" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Committed, but the push failed: network down"),
    );

    // The commit concluded the merge, so git no longer reports one in progress.
    mergeState(false, []);
    fireEvent.click(await screen.findByRole("button", { name: "Push Fixes" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(tauri.aiCommitMergeResolution).toHaveBeenCalledTimes(1);
    expect(tauri.githubPushBranch).toHaveBeenCalledTimes(2);
    expect(tauri.githubMergeBaseBranch).not.toHaveBeenCalled();
  });

  it("warns about files left for a human", async () => {
    mergeState(true, ["logo.png"]);
    tauri.aiResolveMergeConflicts.mockResolvedValue({
      files: [{ path: "logo.png", status: "skipped", reason: "Binary" }],
      remaining: ["logo.png"],
    });
    renderControls();
    fireEvent.click(await screen.findByRole("button", { name: "Resolve Merge Conflicts" }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("by hand"), {
        description: "logo.png: Binary",
      }),
    );
  });
});
