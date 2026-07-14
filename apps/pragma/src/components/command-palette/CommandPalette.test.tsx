import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandPalette } from "./CommandPalette";

const { activateTabLocation, closeTab, onOpenChange, workspace } = vi.hoisted(() => {
  const activateTabLocationMock = vi.fn();
  const closeTabMock = vi.fn();
  return {
    activateTabLocation: activateTabLocationMock,
    closeTab: closeTabMock,
    onOpenChange: vi.fn(),
    workspace: {
      selectedProjectId: "project",
      selectedWorktreeByProject: { project: "worktree" },
      worktrees: {
        project: [
          {
            id: "worktree",
            projectId: "project",
            parentId: null,
            branch: "feature/palette",
            title: "Palette worktree",
            path: "/tmp/project",
            isMain: false,
            hidden: false,
            createdAt: "now",
          },
        ],
      },
      projectTabs: [],
      remoteWorktrees: {},
      runningScripts: [
        {
          worktreeId: "worktree",
          tabId: "script-tab",
          name: "run",
          kind: "run",
          stopping: false,
        },
      ],
      activateTabLocation: activateTabLocationMock,
      closeTab: closeTabMock,
    },
  };
});

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => workspace,
}));

vi.mock("@/state/github-context", () => ({
  useGitHub: () => ({ authenticated: false }),
}));

vi.mock("@/state/kanban-context", () => ({
  useKanban: () => ({ exitBoard: vi.fn() }),
}));

vi.mock("@/state/right-sidebar-context", () => ({
  useRightSidebar: () => ({ setActiveSubtab: vi.fn(), setCollapsed: vi.fn() }),
}));

vi.mock("@/state/agent-status-store", () => ({
  useAgentStatusSnapshot: () => [],
}));

vi.mock("@/hooks/use-agents-list", () => ({
  useAgentsList: () => [],
}));

vi.mock("@/lib/native-overlay", () => ({
  useSuppressNativeOverlayWhile: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  cancelPaletteSearch: vi.fn().mockResolvedValue(undefined),
  githubRepoRef: vi.fn(),
  listWorktreeMru: vi.fn().mockResolvedValue([]),
  paletteSearch: vi.fn(),
  tunnelStatus: vi.fn().mockResolvedValue({ state: "idle" }),
}));

vi.mock("@/lib/github", () => ({
  findPullRequestForBranch: vi.fn(),
}));

function selectRunningScript(): HTMLInputElement {
  const item = screen.getByText("run").closest<HTMLElement>("[cmdk-item]");
  expect(item).not.toBeNull();
  document.querySelectorAll("[cmdk-item]").forEach((candidate) => {
    candidate.setAttribute("data-selected", String(candidate === item));
  });
  return screen.getByPlaceholderText(/Search worktrees/) as HTMLInputElement;
}

describe("CommandPalette running scripts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    render(<CommandPalette mode="search" onOpenChange={onOpenChange} open />);
  });

  it("shows script command and worktree and opens its tab with Enter", () => {
    const input = selectRunningScript();

    expect(screen.getAllByText("Palette worktree")).not.toHaveLength(0);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(activateTabLocation).toHaveBeenCalledWith("project", "worktree", "script-tab");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes selected script with Shift+Enter", () => {
    const input = selectRunningScript();

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(closeTab).toHaveBeenCalledWith("script-tab");
    expect(activateTabLocation).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("CommandPalette nested navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns from a scoped worktree with Escape", () => {
    render(<CommandPalette mode="search" onOpenChange={onOpenChange} open />);
    fireEvent.click(screen.getByText("feature/palette").closest("[cmdk-item]")!);

    expect(screen.getByText("Go to worktree")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByPlaceholderText(/Search worktrees/), { key: "Escape" });

    expect(screen.queryByText("Go to worktree")).not.toBeInTheDocument();
    expect(screen.getByText("feature/palette")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("returns from an editor submenu with Escape", () => {
    render(<CommandPalette mode="command" onOpenChange={onOpenChange} open />);
    fireEvent.click(screen.getByText("Open in VS Code").closest("[cmdk-item]")!);

    expect(screen.getByText("Palette worktree")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByPlaceholderText("Search worktrees..."), { key: "Escape" });

    expect(screen.getByText("Open in VS Code")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
