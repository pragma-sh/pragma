import type {
  ChangedFile,
  ChangeStatus,
  DiffSide,
  Worktree,
  WorktreeChanges,
} from "@pragma/constants";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const worktreeChangesMock = vi.fn();
const discardUnstagedFileMock = vi.fn();
const discardAllUnstagedMock = vi.fn();
const stageFileMock = vi.fn();
const stageAllMock = vi.fn();
const unstageFileMock = vi.fn();
const unstageAllMock = vi.fn();
const commitStagedMock = vi.fn();
const mergeWorktreeToParentMock = vi.fn();
const deleteWorktreeMock = vi.fn();
const getWorktreeStatusMock = vi.fn();
const openDiffTabMock = vi.fn();

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
  mergeWorktreeToParent: (...args: unknown[]) => mergeWorktreeToParentMock(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => workspaceMock,
}));

import { ChangesTab } from "./ChangesTab";

function changes(overrides: Partial<WorktreeChanges> = {}): WorktreeChanges {
  return { committed: [], staged: [], unstaged: [], ...overrides };
}

function change(path: string, status: ChangeStatus, side: DiffSide): ChangedFile {
  return { path, oldPath: null, status, side, additions: null, deletions: null };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  worktreeChangesMock.mockReset();
  discardUnstagedFileMock.mockReset();
  discardAllUnstagedMock.mockReset();
  stageFileMock.mockReset();
  stageAllMock.mockReset();
  unstageFileMock.mockReset();
  unstageAllMock.mockReset();
  commitStagedMock.mockReset();
  mergeWorktreeToParentMock.mockReset();
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

  it("shows merge when a child worktree only has committed changes", async () => {
    workspaceMock = {
      ...workspaceMock,
      selectedWorktreeId: "child",
      selectedWorktree: childWorktree,
      worktrees: { p: [parentWorktree, childWorktree] },
    };
    worktreeChangesMock
      .mockResolvedValueOnce(
        changes({
          committed: [change("src/app.ts", "modified", "committed")],
        }),
      )
      .mockResolvedValueOnce(changes());
    mergeWorktreeToParentMock.mockResolvedValue(undefined);
    render(<ChangesTab />);

    fireEvent.click(await screen.findByRole("button", { name: "Merge into main" }));

    await vi.waitFor(() => expect(mergeWorktreeToParentMock).toHaveBeenCalledWith("child"));
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete worktree" })).toBeTruthy(),
    );
  });

  it("surfaces merge conflicts without replacing the merge action", async () => {
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
    mergeWorktreeToParentMock.mockRejectedValue(new Error("Merge conflicts detected in main"));
    render(<ChangesTab />);

    fireEvent.click(await screen.findByRole("button", { name: "Merge into main" }));

    const { toast } = await import("sonner");
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Merge conflicts detected in main"),
    );
    expect(await screen.findByText("Merge conflicts detected in main")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Merge into main" })).toBeTruthy();
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
