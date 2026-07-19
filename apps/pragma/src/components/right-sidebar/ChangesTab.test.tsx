import type {
  ChangedFile,
  ChangeStatus,
  DiffSide,
  Worktree,
  WorktreeChanges,
} from "@pragma/constants";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const worktreeChangesMock = vi.fn();
const discardUnstagedFileMock = vi.fn();
const discardAllUnstagedMock = vi.fn();
const stageFileMock = vi.fn();
const stageAllMock = vi.fn();
const unstageFileMock = vi.fn();
const unstageAllMock = vi.fn();
const commitStagedMock = vi.fn();
const githubFetchAndSyncMock = vi.fn();
const githubSyncBranchMock = vi.fn();
const aiGenerateCommitMessageMock = vi.fn();
const deleteWorktreeMock = vi.fn();
const getWorktreeStatusMock = vi.fn();
const openDiffTabMock = vi.fn();
let aiAvailableMock = false;

const mainWorktree: Worktree = {
  id: "wt",
  projectId: "p",
  parentId: null,
  branch: "main",
  title: null,
  path: "/repo",
  isMain: true,
  hidden: false,
  createdAt: "2026-01-01",
};
const childWorktree: Worktree = {
  ...mainWorktree,
  id: "child",
  parentId: "parent",
  branch: "feature",
  path: "/repo/.pragma/worktrees/child",
  isMain: false,
};
const parentWorktree: Worktree = {
  ...mainWorktree,
  id: "parent",
};
let workspaceMock: {
  selectedWorktreeId: string;
  selectedProjectId: string;
  selectedWorktree: Worktree;
  worktrees: Record<string, Worktree[]>;
  openDiffTab: typeof openDiffTabMock;
  deleteWorktree: typeof deleteWorktreeMock;
  getWorktreeStatus: typeof getWorktreeStatusMock;
} = {
  selectedWorktreeId: "wt",
  selectedProjectId: "p",
  selectedWorktree: mainWorktree,
  worktrees: { p: [mainWorktree] },
  openDiffTab: openDiffTabMock,
  deleteWorktree: deleteWorktreeMock,
  getWorktreeStatus: getWorktreeStatusMock,
};

vi.mock("@/lib/tauri", () => ({
  worktreeChanges: (...args: unknown[]) => worktreeChangesMock(...args),
  discardUnstagedFile: (...args: unknown[]) => discardUnstagedFileMock(...args),
  discardAllUnstaged: (...args: unknown[]) => discardAllUnstagedMock(...args),
  stageFile: (...args: unknown[]) => stageFileMock(...args),
  stageAll: (...args: unknown[]) => stageAllMock(...args),
  unstageFile: (...args: unknown[]) => unstageFileMock(...args),
  unstageAll: (...args: unknown[]) => unstageAllMock(...args),
  commitStaged: (...args: unknown[]) => commitStagedMock(...args),
  githubFetchAndSync: (...args: unknown[]) => githubFetchAndSyncMock(...args),
  githubSyncBranch: (...args: unknown[]) => githubSyncBranchMock(...args),
  aiGenerateCommitMessage: (...args: unknown[]) => aiGenerateCommitMessageMock(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => workspaceMock,
}));

vi.mock("@/state/ai-context", () => ({
  useAi: () => ({ available: aiAvailableMock }),
}));

import { ChangesTab } from "./ChangesTab";

function changes(overrides: Partial<WorktreeChanges> = {}): WorktreeChanges {
  return { committed: [], staged: [], unstaged: [], ...overrides };
}

function change(path: string, status: ChangeStatus, side: DiffSide): ChangedFile {
  return { path, oldPath: null, status, side, additions: null, deletions: null };
}

beforeEach(() => {
  githubFetchAndSyncMock.mockResolvedValue({
    branch: "feature",
    ahead: 0,
    behind: 0,
    hasUpstream: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  aiAvailableMock = false;
  aiGenerateCommitMessageMock.mockReset();
  worktreeChangesMock.mockReset();
  discardUnstagedFileMock.mockReset();
  discardAllUnstagedMock.mockReset();
  stageFileMock.mockReset();
  stageAllMock.mockReset();
  unstageFileMock.mockReset();
  unstageAllMock.mockReset();
  commitStagedMock.mockReset();
  githubFetchAndSyncMock.mockReset();
  githubSyncBranchMock.mockReset();
  deleteWorktreeMock.mockReset();
  getWorktreeStatusMock.mockReset();
  openDiffTabMock.mockReset();
  workspaceMock = {
    selectedWorktreeId: "wt",
    selectedProjectId: "p",
    selectedWorktree: mainWorktree,
    worktrees: { p: [mainWorktree] },
    openDiffTab: openDiffTabMock,
    deleteWorktree: deleteWorktreeMock,
    getWorktreeStatus: getWorktreeStatusMock,
  };
});

describe("ChangesTab", () => {
  it("shows 'No committed changes' when there are none", async () => {
    worktreeChangesMock.mockResolvedValue(changes());
    render(<ChangesTab />);
    expect(await screen.findByText("No committed changes")).toBeTruthy();
  });

  it("re-queries git on an interval and updates the lists in place", async () => {
    vi.useFakeTimers();
    worktreeChangesMock.mockResolvedValue(changes());
    render(<ChangesTab />);
    await vi.waitFor(() => expect(worktreeChangesMock).toHaveBeenCalledTimes(1));

    // A file appears after the first load — the next poll should surface it
    // without remounting (no loading flash).
    worktreeChangesMock.mockResolvedValue(
      changes({
        unstaged: [change("src/app.ts", "modified", "unstaged")],
      }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(worktreeChangesMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(screen.getByText("app.ts")).toBeTruthy());
  });

  it("discards a single unstaged file after confirming", async () => {
    worktreeChangesMock.mockResolvedValue(
      changes({
        unstaged: [change("src/app.ts", "modified", "unstaged")],
      }),
    );
    discardUnstagedFileMock.mockResolvedValue(undefined);
    render(<ChangesTab />);
    await screen.findByText("app.ts");

    fireEvent.click(screen.getByLabelText("Discard changes to app.ts"));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));

    await vi.waitFor(() =>
      expect(discardUnstagedFileMock).toHaveBeenCalledWith("wt", "src/app.ts", "modified", null),
    );
  });

  it("does not discard when the confirmation is cancelled", async () => {
    worktreeChangesMock.mockResolvedValue(
      changes({
        unstaged: [change("src/app.ts", "modified", "unstaged")],
      }),
    );
    render(<ChangesTab />);
    await screen.findByText("app.ts");

    fireEvent.click(screen.getByLabelText("Discard changes to app.ts"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(discardUnstagedFileMock).not.toHaveBeenCalled();
  });

  it("opens a worktree-base diff when a file is clicked, regardless of its list", async () => {
    worktreeChangesMock.mockResolvedValue(
      changes({
        committed: [change("src/committed.ts", "modified", "committed")],
        staged: [change("src/staged.ts", "modified", "staged")],
        unstaged: [change("src/unstaged.ts", "modified", "unstaged")],
      }),
    );
    render(<ChangesTab />);
    await screen.findByText("committed.ts");

    fireEvent.click(screen.getByText("committed.ts"));
    fireEvent.click(screen.getByText("staged.ts"));
    fireEvent.click(screen.getByText("unstaged.ts"));

    expect(openDiffTabMock).toHaveBeenCalledWith("src/committed.ts", "worktree");
    expect(openDiffTabMock).toHaveBeenCalledWith("src/staged.ts", "worktree");
    expect(openDiffTabMock).toHaveBeenCalledWith("src/unstaged.ts", "worktree");
  });

  it("stages a single unstaged file without confirmation", async () => {
    worktreeChangesMock.mockResolvedValue(
      changes({
        unstaged: [change("src/app.ts", "modified", "unstaged")],
      }),
    );
    stageFileMock.mockResolvedValue(undefined);
    render(<ChangesTab />);
    await screen.findByText("app.ts");

    fireEvent.click(screen.getByLabelText("Stage app.ts"));

    await vi.waitFor(() => expect(stageFileMock).toHaveBeenCalledWith("wt", "src/app.ts"));
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  it("unstages a single staged file without confirmation", async () => {
    worktreeChangesMock.mockResolvedValue(
      changes({
        staged: [change("src/app.ts", "modified", "staged")],
      }),
    );
    unstageFileMock.mockResolvedValue(undefined);
    render(<ChangesTab />);
    await screen.findByText("app.ts");

    fireEvent.click(screen.getByLabelText("Unstage app.ts"));

    await vi.waitFor(() => expect(unstageFileMock).toHaveBeenCalledWith("wt", "src/app.ts", null));
  });

  it("stages and unstages all changes from the group headers", async () => {
    worktreeChangesMock.mockResolvedValue(
      changes({
        staged: [change("src/a.ts", "modified", "staged")],
        unstaged: [change("src/b.ts", "modified", "unstaged")],
      }),
    );
    stageAllMock.mockResolvedValue(undefined);
    unstageAllMock.mockResolvedValue(undefined);
    render(<ChangesTab />);
    await screen.findByText("a.ts");

    fireEvent.click(screen.getByLabelText("Stage all changes"));
    await vi.waitFor(() => expect(stageAllMock).toHaveBeenCalledWith("wt"));

    fireEvent.click(screen.getByLabelText("Unstage all changes"));
    await vi.waitFor(() => expect(unstageAllMock).toHaveBeenCalledWith("wt"));
  });

  it("disables the commit input and button when no changes are staged", async () => {
    worktreeChangesMock.mockResolvedValue(changes());
    render(<ChangesTab />);
    await screen.findByText("No committed changes");

    const input = screen.getByLabelText("Commit message") as HTMLInputElement;
    const button = screen.getByRole("button", { name: "Commit" });
    expect(input.disabled).toBe(true);
    expect(button).toBeDisabled();
  });

  it("keeps the commit button disabled until a non-empty message is typed", async () => {
    worktreeChangesMock.mockResolvedValue(
      changes({
        staged: [change("src/app.ts", "modified", "staged")],
      }),
    );
    render(<ChangesTab />);
    await screen.findByText("app.ts");

    const input = screen.getByLabelText("Commit message") as HTMLInputElement;
    const button = screen.getByRole("button", { name: "Commit" });
    expect(button).toBeDisabled();

    fireEvent.change(input, { target: { value: "   " } });
    expect(button).toBeDisabled();

    fireEvent.change(input, { target: { value: "ship it" } });
    expect(button).toBeEnabled();
  });

  it("submits the commit, clears the message, and refreshes", async () => {
    worktreeChangesMock.mockResolvedValue(
      changes({
        staged: [change("src/app.ts", "modified", "staged")],
      }),
    );
    commitStagedMock.mockResolvedValue(undefined);
    render(<ChangesTab />);
    await screen.findByText("app.ts");

    const input = screen.getByLabelText("Commit message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  ship it  " } });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await vi.waitFor(() => expect(commitStagedMock).toHaveBeenCalledWith("wt", "ship it"));
    // The input is cleared and a follow-up poll picks up the post-commit state.
    await vi.waitFor(() => expect(input.value).toBe(""));
    await vi.waitFor(() => expect(worktreeChangesMock).toHaveBeenCalledTimes(2));
  });

  it("submits on ⌘/Ctrl-Enter from the input", async () => {
    worktreeChangesMock.mockResolvedValue(
      changes({
        staged: [change("src/app.ts", "modified", "staged")],
      }),
    );
    commitStagedMock.mockResolvedValue(undefined);
    render(<ChangesTab />);
    await screen.findByText("app.ts");

    const input = screen.getByLabelText("Commit message");
    fireEvent.change(input, { target: { value: "ship it" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    await vi.waitFor(() => expect(commitStagedMock).toHaveBeenCalledWith("wt", "ship it"));
  });

  it("surfaces commit errors via toast and keeps the message", async () => {
    worktreeChangesMock.mockResolvedValue(
      changes({
        staged: [change("src/app.ts", "modified", "staged")],
      }),
    );
    commitStagedMock.mockRejectedValue(new Error("nothing to commit"));
    render(<ChangesTab />);
    await screen.findByText("app.ts");

    const input = screen.getByLabelText("Commit message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ship it" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    const { toast } = await import("sonner");
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("nothing to commit"));
    // The user can retry without re-typing.
    expect(input.value).toBe("ship it");
  });

  it("shows the generate hint and fills the message on Shift+Tab when AI is available", async () => {
    aiAvailableMock = true;
    aiGenerateCommitMessageMock.mockResolvedValue("feat: add the thing");
    worktreeChangesMock.mockResolvedValue(
      changes({
        staged: [change("src/app.ts", "modified", "staged")],
      }),
    );
    render(<ChangesTab />);
    await screen.findByText("app.ts");

    const input = screen.getByPlaceholderText("Shift + tab to generate") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });

    await vi.waitFor(() => expect(aiGenerateCommitMessageMock).toHaveBeenCalledWith("wt"));
    await vi.waitFor(() => expect(input.value).toBe("feat: add the thing"));
  });

  it("toasts and does not generate on Shift+Tab when nothing is staged", async () => {
    aiAvailableMock = true;
    worktreeChangesMock.mockResolvedValue(changes());
    render(<ChangesTab />);
    await screen.findByText("No committed changes");

    const input = screen.getByPlaceholderText("Shift + tab to generate");
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });

    const { toast } = await import("sonner");
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "No staged changes to generate a commit message from.",
      ),
    );
    expect(aiGenerateCommitMessageMock).not.toHaveBeenCalled();
  });

  it("hides the generate hint when AI is unavailable", async () => {
    worktreeChangesMock.mockResolvedValue(
      changes({
        staged: [change("src/app.ts", "modified", "staged")],
      }),
    );
    render(<ChangesTab />);
    await screen.findByText("app.ts");

    expect(screen.getByPlaceholderText("Commit message")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Shift + tab to generate")).toBeNull();
  });

  it("shows remote sync counts when a child worktree only has committed changes", async () => {
    workspaceMock = {
      ...workspaceMock,
      selectedWorktreeId: "child",
      selectedWorktree: childWorktree,
      worktrees: { p: [parentWorktree, childWorktree] },
    };
    worktreeChangesMock.mockResolvedValue(
      changes({
        committed: [change("src/app.ts", "modified", "committed")],
      }),
    );
    githubFetchAndSyncMock.mockResolvedValue({
      branch: "feature",
      ahead: 2,
      behind: 1,
      hasUpstream: true,
    });
    githubSyncBranchMock.mockResolvedValue(undefined);
    render(<ChangesTab />);

    fireEvent.click(await screen.findByRole("button", { name: "Sync with remote" }));

    await vi.waitFor(() => expect(githubSyncBranchMock).toHaveBeenCalledWith("child"));
    expect(screen.getByTitle("1 commit(s) to pull")).toHaveTextContent("1");
    expect(screen.getByTitle("2 commit(s) to push")).toHaveTextContent("2");
  });

  it("replaces commit controls for any clean worktree with committed changes", async () => {
    workspaceMock = {
      ...workspaceMock,
      selectedWorktreeId: "orphan",
      selectedWorktree: { ...childWorktree, id: "orphan", parentId: null },
      worktrees: { p: [{ ...childWorktree, id: "orphan", parentId: null }] },
    };
    worktreeChangesMock.mockResolvedValue(
      changes({
        committed: [change("src/app.ts", "modified", "committed")],
      }),
    );
    render(<ChangesTab />);

    expect(await screen.findByRole("button", { name: "Sync with remote" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Commit message")).not.toBeInTheDocument();
  });

  it("shows sync for a clean main branch that differs from its remote", async () => {
    worktreeChangesMock.mockResolvedValue(changes());
    githubFetchAndSyncMock.mockResolvedValue({
      branch: "main",
      ahead: 1,
      behind: 0,
      hasUpstream: true,
    });
    render(<ChangesTab />);

    expect(await screen.findByRole("button", { name: "Sync with remote" })).toBeInTheDocument();
    expect(screen.getByTitle("1 commit(s) to push")).toHaveTextContent("1");
  });

  it("surfaces sync conflicts without replacing the sync action", async () => {
    workspaceMock = {
      ...workspaceMock,
      selectedWorktreeId: "child",
      selectedWorktree: childWorktree,
      worktrees: { p: [parentWorktree, childWorktree] },
    };
    worktreeChangesMock.mockResolvedValue(
      changes({
        committed: [change("src/app.ts", "modified", "committed")],
      }),
    );
    githubSyncBranchMock.mockRejectedValue(
      new Error("Remote changes conflict with local commits. Pull was aborted."),
    );
    render(<ChangesTab />);

    fireEvent.click(await screen.findByRole("button", { name: "Sync with remote" }));

    const { toast } = await import("sonner");
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Remote changes conflict with local commits. Pull was aborted.",
      ),
    );
    expect(
      await screen.findByText("Remote changes conflict with local commits. Pull was aborted."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync with remote" })).toBeTruthy();
  });

  it("shows the delete worktree action after a child has no remaining changes", async () => {
    workspaceMock = {
      ...workspaceMock,
      selectedWorktreeId: "child",
      selectedWorktree: childWorktree,
      worktrees: { p: [parentWorktree, childWorktree] },
    };
    worktreeChangesMock.mockResolvedValue(changes());
    render(<ChangesTab />);

    expect(await screen.findByRole("button", { name: "Delete worktree" })).toBeTruthy();
    expect(screen.queryByLabelText("Commit message")).toBeNull();
  });
});
