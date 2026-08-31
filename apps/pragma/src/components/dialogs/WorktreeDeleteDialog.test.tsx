import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const deleteWorktreeMock = vi.fn();
const getWorktreeStatusMock = vi.fn();

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({
    deleteWorktree: (...args: unknown[]) => deleteWorktreeMock(...args),
    getWorktreeStatus: (...args: unknown[]) => getWorktreeStatusMock(...args),
  }),
}));

import { WorktreeDeleteDialog } from "./WorktreeDeleteDialog";

describe("WorktreeDeleteDialog", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("closes before background deletion settles", async () => {
    const onOpenChange = vi.fn();
    getWorktreeStatusMock.mockResolvedValue({ dirty: false });
    deleteWorktreeMock.mockReturnValue(new Promise(() => {}));
    render(
      <WorktreeDeleteDialog
        open
        worktreeId="feature"
        worktreeLabel="feature"
        onOpenChange={onOpenChange}
      />,
    );
    await waitFor(() => expect(getWorktreeStatusMock).toHaveBeenCalledWith("feature"));

    fireEvent.click(screen.getByRole("button", { name: "Delete anyway" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(deleteWorktreeMock).toHaveBeenCalledWith("feature", {
      deleteBranch: false,
      force: false,
    });
  });
});
