import type { Worktree } from "@pragma/constants";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const worktreesMergedStatusMock = vi.fn();
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
  worktreesMergedStatus: (...args: unknown[]) => worktreesMergedStatusMock(...args),
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => workspaceMock,
}));

vi.mock("@/state/kanban-context", () => ({
  useKanban: () => ({ exitBoard: vi.fn() }),
}));

import { WorktreeTree } from "./WorktreeTree";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  worktreesMergedStatusMock.mockReset();
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
    worktreesMergedStatusMock.mockResolvedValue({ child: true });

    const { container } = render(<WorktreeTree onCreateChild={vi.fn()} />);

    await screen.findByText("feature");
    await vi.waitFor(() => expect(worktreesMergedStatusMock).toHaveBeenCalledWith(["child"]));
    await vi.waitFor(() => expect(container.querySelector(".lucide-git-merge")).toBeTruthy());
  });

  it("keeps the branch icon for a child worktree with remaining changes", async () => {
    worktreesMergedStatusMock.mockResolvedValue({ child: false });

    const { container } = render(<WorktreeTree onCreateChild={vi.fn()} />);

    await screen.findByText("feature");
    await vi.waitFor(() => expect(worktreesMergedStatusMock).toHaveBeenCalledWith(["child"]));
    expect(container.querySelector(".lucide-git-merge")).toBeNull();
  });
});
