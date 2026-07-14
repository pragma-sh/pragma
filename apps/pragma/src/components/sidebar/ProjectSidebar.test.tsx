import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const openSettingsMock = vi.fn();

vi.mock("@/state/kanban-context", () => ({
  useKanban: () => ({
    mode: "normal",
    openBoard: vi.fn(),
    openAutomations: vi.fn(),
    openSettings: openSettingsMock,
    exitBoard: vi.fn(),
  }),
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({
    activeProject: { name: "Pragma" },
    selectedProjectId: "project-1",
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
vi.mock("@/components/dialogs/CreateProjectDialog", () => ({ CreateProjectDialog: () => null }));
vi.mock("@/components/dialogs/CreateWorktreeDialog", () => ({ CreateWorktreeDialog: () => null }));

import { ProjectSidebar } from "./ProjectSidebar";

afterEach(() => {
  cleanup();
  openSettingsMock.mockReset();
});

describe("ProjectSidebar", () => {
  it("opens settings from the gear button", () => {
    render(<ProjectSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));

    expect(openSettingsMock).toHaveBeenCalledOnce();
  });
});
