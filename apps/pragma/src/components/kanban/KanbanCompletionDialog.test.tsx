import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { KanbanPromptCard } from "@pragma/constants";

import { KanbanCompletionDialog } from "@/components/kanban/KanbanCompletionDialog";

vi.mock("@/state/kanban-context", () => ({
  useKanban: () => ({
    completeCard: vi.fn(),
    runCompletion: vi.fn(),
    openCardWorktree: vi.fn(),
  }),
}));

afterEach(cleanup);

const card: KanbanPromptCard = {
  id: "card-1",
  projectId: "project-1",
  branchName: "feature/x",
  prompt: "Do the thing",
  agentId: "claude",
  status: "reviewNeeded",
  schedulingMode: "manual",
  createdAt: "2026-08-15T00:00:00Z",
  updatedAt: "2026-08-15T00:00:00Z",
};

describe("KanbanCompletionDialog", () => {
  it("does not offer local merge completion", () => {
    render(<KanbanCompletionDialog open onOpenChange={vi.fn()} card={card} />);

    expect(screen.queryByRole("button", { name: /commit all and merge/i })).toBeNull();
    expect(screen.getByRole("button", { name: /commit all and open pr/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /go to worktree/i })).toBeTruthy();
  });
});
