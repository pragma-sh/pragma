import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteWhiteboard: vi.fn(),
  exitBoard: vi.fn(),
  listWhiteboards: vi.fn(),
  openWhiteboard: vi.fn(),
}));

// Mutable because individual tests need a different workspace shape (no
// selected worktree). Hoisted so the vi.mock factory below can close over it.
const workspaceState = vi.hoisted(() => ({
  selectedWorktreeId: "worktree-1" as string | null,
  projectTabs: [] as unknown[],
  closeTab: vi.fn(async () => undefined),
}));

const board = {
  id: "board-1",
  worktreeId: "worktree-1",
  title: "Architecture",
  scene: {},
  version: 1,
  createdAt: 1,
  updatedAt: 1,
};

vi.mock("@/lib/tauri", () => ({
  deleteWhiteboard: mocks.deleteWhiteboard,
  listWhiteboards: mocks.listWhiteboards,
}));
vi.mock("@/state/kanban-context", () => ({ useKanban: () => ({ exitBoard: mocks.exitBoard }) }));
vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({
    closeTab: workspaceState.closeTab,
    createWhiteboard: vi.fn(),
    openWhiteboard: mocks.openWhiteboard,
    projectTabs: workspaceState.projectTabs,
    selectedWorktreeId: workspaceState.selectedWorktreeId,
  }),
}));

import { WhiteboardsCard } from "./WhiteboardsCard";

beforeEach(() => {
  mocks.deleteWhiteboard.mockReset().mockResolvedValue(undefined);
  mocks.exitBoard.mockReset();
  mocks.listWhiteboards.mockReset().mockResolvedValue([board]);
  mocks.openWhiteboard.mockReset();
  workspaceState.selectedWorktreeId = "worktree-1";
  workspaceState.projectTabs = [];
});

afterEach(cleanup);

describe("WhiteboardsCard", () => {
  it("opens a listed whiteboard from the agent board", async () => {
    render(<WhiteboardsCard />);

    fireEvent.click(await screen.findByRole("button", { name: "Architecture" }));

    expect(mocks.exitBoard).toHaveBeenCalledOnce();
    expect(mocks.openWhiteboard).toHaveBeenCalledWith("board-1", "Architecture");
  });

  it("has no create action in the header", async () => {
    render(<WhiteboardsCard />);

    await screen.findByRole("button", { name: "Architecture" });

    expect(screen.queryByRole("button", { name: "Create whiteboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New whiteboard" })).not.toBeInTheDocument();
  });

  it("renders nothing while the worktree's list is still loading", () => {
    mocks.listWhiteboards.mockReturnValue(new Promise(() => {}));

    const { container } = render(<WhiteboardsCard />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the worktree has no whiteboards", async () => {
    mocks.listWhiteboards.mockResolvedValue([]);

    const { container } = render(<WhiteboardsCard />);

    await waitFor(() => {
      expect(mocks.listWhiteboards).toHaveBeenCalledOnce();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing without a selected worktree", () => {
    workspaceState.selectedWorktreeId = null;

    const { container } = render(<WhiteboardsCard />);

    expect(container).toBeEmptyDOMElement();
    expect(mocks.listWhiteboards).not.toHaveBeenCalled();
  });

  it("hides a stale list while switching to another worktree", async () => {
    const { rerender, container } = render(<WhiteboardsCard />);
    await screen.findByRole("button", { name: "Architecture" });

    mocks.listWhiteboards.mockReturnValue(new Promise(() => {}));
    workspaceState.selectedWorktreeId = "worktree-2";
    rerender(<WhiteboardsCard />);

    await waitFor(() => {
      expect(mocks.listWhiteboards).toHaveBeenLastCalledWith("worktree-2");
    });
    // The previous worktree's board must not render under the new one.
    expect(screen.queryByRole("button", { name: "Architecture" })).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
