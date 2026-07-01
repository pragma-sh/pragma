import type { Worktree } from "@pragma/constants";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const worktreesMergedStatusMock = vi.fn();
const hideWorktreeMock = vi.fn();
const selectWorktreeMock = vi.fn();
const renameWorktreeMock = vi.fn();
const openWorktreeInEditorMock = vi.fn();
const subscribeToWorktreeFilesMock = vi.fn((_worktreeId: string, _listener: unknown) => vi.fn());

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
  remoteWorktrees: {},
  hideWorktree: hideWorktreeMock,
  openWorktreeInEditor: openWorktreeInEditorMock,
  renameWorktree: renameWorktreeMock,
  selectWorktree: selectWorktreeMock,
};

vi.mock("@/lib/tauri", () => ({
  worktreesMergedStatus: (...args: unknown[]) => worktreesMergedStatusMock(...args),
}));

vi.mock("@/lib/file-watch", () => ({
  subscribeToWorktreeFiles: (worktreeId: string, listener: unknown) =>
    subscribeToWorktreeFilesMock(worktreeId, listener),
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
  subscribeToWorktreeFilesMock.mockClear();
  workspaceMock = {
    selectedProjectId: "p",
    selectedWorktreeId: "main",
    worktrees: { p: [mainWorktree, childWorktree] },
    remoteWorktrees: {},
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

  it("opens the row context menu on right click", async () => {
    worktreesMergedStatusMock.mockResolvedValue({ child: false });

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    const rowLabel = await screen.findByText("main");

    fireEvent.contextMenu(rowLabel);

    expect(screen.getByRole("menuitem", { name: "Copy worktree path" })).toBeInTheDocument();
  });

  it("disables the editor submenu for remote worktrees", async () => {
    worktreesMergedStatusMock.mockResolvedValue({ child: false });
    workspaceMock.remoteWorktrees = { main: true };

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    const rowLabel = await screen.findByText("main");

    fireEvent.contextMenu(rowLabel);

    expect(screen.getByRole("menuitem", { name: "Open in editor" })).toHaveAttribute(
      "data-disabled",
    );
  });

  it("shows the new-worktree button on the main worktree row", async () => {
    worktreesMergedStatusMock.mockResolvedValue({ child: false });
    const onCreateChild = vi.fn();

    render(<WorktreeTree onCreateChild={onCreateChild} />);

    const button = await screen.findByRole("button", { name: "New worktree from main" });
    fireEvent.click(button);

    expect(selectWorktreeMock).toHaveBeenCalledWith("main");
    expect(onCreateChild).toHaveBeenCalledOnce();
  });
});
