import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/kanban-context", () => ({
  useKanban: () => ({
    mode: "normal",
    openBoard: vi.fn(),
    openSettings: vi.fn(),
    exitBoard: vi.fn(),
  }),
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({
    activeProject: { name: "Pragma" },
    selectedProjectId: "project-1",
    worktrees: { "project-1": [{ id: "main-1", isMain: true }] },
  }),
}));

vi.mock("@/hooks/use-project-cycle", () => ({
  useProjectCycle: () => ({
    onWheel: vi.fn(),
    onTouchStart: vi.fn(),
    onTouchEnd: vi.fn(),
  }),
}));

vi.mock("@/plugins/rendering", () => ({
  RenderPluginContribution: () => null,
  usePluginSidebarCards: () => [],
}));

vi.mock("@/components/sidebar/WorktreeTree", () => ({ WorktreeTree: () => null }));
vi.mock("@/components/sidebar/ProjectSwitcher", () => ({ ProjectSwitcher: () => null }));
vi.mock("@/components/sidebar/OpenPortsCard", () => ({ OpenPortsCard: () => null }));
vi.mock("@/components/dialogs/CreateProjectDialog", () => ({ CreateProjectDialog: () => null }));
vi.mock("@/components/dialogs/CreateWorktreeDialog", () => ({ CreateWorktreeDialog: () => null }));

import { LeftSidebarProvider } from "@/state/left-sidebar-context";
import { ProjectSidebar } from "./ProjectSidebar";

function renderSidebar() {
  return render(
    <LeftSidebarProvider>
      <ProjectSidebar />
    </LeftSidebarProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ProjectSidebar", () => {
  it("collapses to a strip and expands again", () => {
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Collapse project sidebar" }));
    expect(screen.queryByRole("button", { name: "Collapse project sidebar" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand project sidebar" }));
    expect(screen.getByRole("button", { name: "Collapse project sidebar" })).toBeTruthy();
  });

  it("offers new-worktree and add-project entries from the plus menu", async () => {
    renderSidebar();

    // Radix dropdown triggers open on pointerdown, not click.
    await userEvent.click(screen.getByRole("button", { name: "Add project or worktree" }));

    expect(await screen.findByText("New worktree off main")).toBeTruthy();
    expect(screen.getByText("Add project")).toBeTruthy();
  });
});
