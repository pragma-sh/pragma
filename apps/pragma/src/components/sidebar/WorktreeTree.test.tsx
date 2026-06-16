import type {
  ChangedFile,
  ChangeStatus,
  DiffSide,
  Worktree,
  WorktreeChanges,
} from "@pragma/constants";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const worktreeChangesMock = vi.fn();
const hideWorktreeMock = vi.fn();
const selectWorktreeMock = vi.fn();
const renameWorktreeMock = vi.fn();
const openWorktreeInEditorMock = vi.fn();

const mainWorktree: Worktree = {
  id: "main",
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
  id: "child",
  projectId: "p",
  parentId: "main",
  branch: "feature",
  title: null,
  path: "/repo/.pragma/worktrees/child",
  isMain: false,
  hidden: false,
  createdAt: "2026-01-02",
};

let workspaceMock = {
  selectedProjectId: "p",
  selectedWorktreeId: "main",
  worktrees: { p: [mainWorktree, childWorktree] },
  hideWorktree: hideWorktreeMock,
  openWorktreeInEditor: openWorktreeInEditorMock,
  renameWorktree: renameWorktreeMock,
  selectWorktree: selectWorktreeMock,
};

vi.mock("@/lib/tauri", () => ({
  worktreeChanges: (...args: unknown[]) => worktreeChangesMock(...args),
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => workspaceMock,
}));

import { WorktreeTree } from "./WorktreeTree";

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
  hideWorktreeMock.mockReset();
  openWorktreeInEditorMock.mockReset();
  renameWorktreeMock.mockReset();
  selectWorktreeMock.mockReset();
  workspaceMock = {
    selectedProjectId: "p",
    selectedWorktreeId: "main",
    worktrees: { p: [mainWorktree, childWorktree] },
    hideWorktree: hideWorktreeMock,
    openWorktreeInEditor: openWorktreeInEditorMock,
    renameWorktree: renameWorktreeMock,
    selectWorktree: selectWorktreeMock,
  };
});

describe("WorktreeTree", () => {
  it("uses the merged icon for a child worktree with no remaining changes", async () => {
    worktreeChangesMock.mockResolvedValue(changes());

    const { container } = render(<WorktreeTree onCreateChild={vi.fn()} />);

    await screen.findByText("feature");
    await vi.waitFor(() => expect(worktreeChangesMock).toHaveBeenCalledWith("child"));
    expect(container.querySelector(".lucide-git-merge")).toBeTruthy();
  });

  it("keeps the branch icon for a child worktree with committed changes", async () => {
    worktreeChangesMock.mockResolvedValue(
      changes({
        committed: [change("src/app.ts", "modified", "committed")],
      }),
    );

    const { container } = render(<WorktreeTree onCreateChild={vi.fn()} />);

    await screen.findByText("feature");
    await vi.waitFor(() => expect(worktreeChangesMock).toHaveBeenCalledWith("child"));
    expect(container.querySelector(".lucide-git-merge")).toBeNull();
  });
});
