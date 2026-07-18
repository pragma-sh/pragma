import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OpenPortsCard } from "./OpenPortsCard";

const { activateTabLocation, openPorts, workspace } = vi.hoisted(() => ({
  activateTabLocation: vi.fn(),
  openPorts: [
    {
      port: 5173,
      process: "vite",
      pid: 123,
      tabId: "tab-1",
      worktreeId: "worktree",
    },
    {
      port: 1420,
      process: "pragma-server",
      pid: 999,
      tabId: "missing-internal-tab",
      worktreeId: "worktree",
    },
  ],
  workspace: {
    selectedProjectId: "project",
    worktrees: {
      project: [
        {
          id: "worktree",
          projectId: "project",
          parentId: null,
          branch: "feature/ports",
          title: "Ports worktree",
          path: "/tmp/project",
          isMain: false,
          hidden: false,
          createdAt: "now",
        },
        {
          id: "idle-worktree",
          projectId: "project",
          parentId: null,
          branch: "feature/idle",
          title: "Idle worktree",
          path: "/tmp/idle",
          isMain: false,
          hidden: false,
          createdAt: "now",
        },
      ],
    },
    projectTabs: [
      {
        id: "tab-1",
        projectId: "project",
        worktreeId: "worktree",
        kind: "terminal",
        title: "Vite server",
      },
    ],
    activateTabLocation: vi.fn(),
  },
}));

workspace.activateTabLocation = activateTabLocation;

vi.mock("@/state/workspace-context", () => ({ useWorkspace: () => workspace }));
vi.mock("@/state/open-ports-context", () => ({
  useOpenPorts: () => openPorts,
}));

describe("OpenPortsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openPorts.splice(
      0,
      openPorts.length,
      {
        port: 5173,
        process: "vite",
        pid: 123,
        tabId: "tab-1",
        worktreeId: "worktree",
      },
      {
        port: 1420,
        process: "pragma-server",
        pid: 999,
        tabId: "missing-internal-tab",
        worktreeId: "worktree",
      },
    );
  });

  it("shows only ports backed by visible terminal tabs and activates their tab", () => {
    render(<OpenPortsCard />);

    expect(screen.getByText("Ports worktree")).toBeInTheDocument();
    expect(screen.queryByText("Idle worktree")).not.toBeInTheDocument();
    expect(screen.getByText("5173")).toBeInTheDocument();
    expect(screen.queryByText("1420")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("5173"));

    expect(activateTabLocation).toHaveBeenCalledWith("project", "worktree", "tab-1");
  });

  it("hides the card when no visible terminal tab owns a port", () => {
    openPorts.splice(0, openPorts.length);

    render(<OpenPortsCard />);

    expect(
      screen.queryByRole("button", { name: "Toggle open ports panel" }),
    ).not.toBeInTheDocument();
  });
});
