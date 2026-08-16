import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exitBoard: vi.fn(),
  listScratchpads: vi.fn(),
  openScratchpadFile: vi.fn(),
}));

vi.mock("@/lib/file-watch", () => ({ useWorktreeFileChange: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ listScratchpads: mocks.listScratchpads }));
vi.mock("@/state/kanban-context", () => ({ useKanban: () => ({ exitBoard: mocks.exitBoard }) }));
vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({
    openScratchpadFile: mocks.openScratchpadFile,
    projectTabs: [],
    selectedWorktreeId: "worktree-1",
  }),
}));

import { ScratchpadsCard } from "./ScratchpadsCard";

beforeEach(() => {
  mocks.exitBoard.mockReset();
  mocks.listScratchpads.mockReset();
  mocks.listScratchpads.mockResolvedValue([
    { id: "scratchpad-1", filePath: ".pragma/scratchpads/plan.mdx", title: "Plan" },
  ]);
  mocks.openScratchpadFile.mockReset();
});

afterEach(cleanup);

describe("ScratchpadsCard", () => {
  it("leaves the agent board before opening a scratchpad tab", async () => {
    render(<ScratchpadsCard />);

    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));

    expect(mocks.exitBoard).toHaveBeenCalledOnce();
    expect(mocks.openScratchpadFile).toHaveBeenCalledWith(".pragma/scratchpads/plan.mdx", "Plan");
  });
});
