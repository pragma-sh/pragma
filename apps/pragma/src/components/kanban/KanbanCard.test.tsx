import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { KanbanPromptCard, KanbanPromptStatus } from "@pragma/constants";

import { KanbanCard } from "@/components/kanban/KanbanCard";
import type { AgentConfig } from "@/lib/tauri";

afterEach(cleanup);

function card(overrides: Partial<KanbanPromptCard> = {}): KanbanPromptCard {
  return {
    id: "card-1",
    projectId: "proj-1",
    branchName: "feature/x",
    prompt: "Do the thing",
    agentId: "claude",
    status: "draft" as KanbanPromptStatus,
    schedulingMode: "manual",
    createdAt: "2026-06-25T00:00:00Z",
    updatedAt: "2026-06-25T00:00:00Z",
    ...overrides,
  };
}

function noopProps() {
  return {
    agent: agent(),
    onOpen: vi.fn(),
    onDelete: vi.fn(),
  };
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "claude",
    name: "Claude",
    iconDataUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
    start: ["claude"],
    ...overrides,
  };
}

describe("KanbanCard", () => {
  it("opens the worktree when an in-progress card is clicked", () => {
    const props = noopProps();
    render(<KanbanCard card={card({ status: "inProgress", agentTabId: "tab-1" })} {...props} />);
    fireEvent.click(screen.getByText("feature/x"));
    expect(props.onOpen).toHaveBeenCalledTimes(1);
  });

  it("only renders the footer delete action button", () => {
    render(<KanbanCard card={card({ status: "reviewNeeded" })} {...noopProps()} />);
    expect(screen.queryByRole("button", { name: "Start card" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete card" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Commit and merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Commit and open PR" })).toBeNull();
  });

  it("invokes onDelete from the delete button", () => {
    const props = noopProps();
    render(<KanbanCard card={card()} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete card" }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it("shows a live merge badge while a completion runs in the background", () => {
    render(
      <KanbanCard
        card={card({ status: "completed", completedAction: "commitMerge" })}
        completingAction="commitMerge"
        {...noopProps()}
      />,
    );
    expect(screen.getByText("Merging…")).toBeTruthy();
  });

  it("renders the agent as its plugin icon in the footer", () => {
    const { container } = render(<KanbanCard card={card()} {...noopProps()} />);
    expect(screen.queryByText("Claude")).toBeNull();
    expect(container.querySelector('img[src^="data:image/svg+xml"]')).toBeTruthy();
    expect(screen.getByLabelText("Agent: Claude")).toBeTruthy();
  });

  it("shows a Merged badge on a completed merge", () => {
    render(
      <KanbanCard
        card={card({ status: "completed", completedAction: "commitMerge" })}
        {...noopProps()}
      />,
    );
    expect(screen.getByText("Merged")).toBeTruthy();
  });

  it("shows a PR badge on a completed card with a pull request", () => {
    render(
      <KanbanCard
        card={card({
          status: "completed",
          completedAction: "commitPr",
          pullRequestUrl: "https://example.com/pr/7",
          pullRequestNumber: 7,
        })}
        {...noopProps()}
      />,
    );
    expect(screen.getByText("PR #7")).toBeTruthy();
    // Completed cards expose no footer actions.
    expect(screen.queryByRole("button", { name: "Start card" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete" })).toBeNull();
  });
});
