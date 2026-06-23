import type { Tab } from "@pragma/constants";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalTabs } from "./TerminalTabs";
import { useWorkspace } from "@/state/workspace-context";

type WorkspaceContextValue = ReturnType<typeof useWorkspace>;

function tab(id: string): Tab {
  return {
    id,
    projectId: "project",
    worktreeId: "worktree",
    kind: "terminal",
    title: id,
    url: null,
    filePath: null,
    diffSide: null,
    prNumber: null,
    userRenamed: false,
    orderIndex: 0,
    createdAt: "now",
  };
}

const splitRoot: WorkspaceContextValue["splitRoot"] = {
  kind: "split",
  id: "split-1",
  direction: "horizontal",
  children: [
    {
      kind: "pane",
      id: "pane-left",
      tabIds: ["one"],
      activeTabId: "one",
    },
    {
      kind: "pane",
      id: "pane-right",
      tabIds: ["two", "three"],
      activeTabId: "two",
    },
  ],
};

const mockWorkspace: WorkspaceContextValue = {
  projects: [],
  worktrees: {},
  tabs: [tab("one"), tab("two"), tab("three")],
  selectedProjectId: null,
  selectedWorktreeByProject: {},
  activeTabByWorktree: { worktree: "one" },
  splitRootByWorktree: {},
  focusedPaneByWorktree: { worktree: "pane-right" },
  icons: {},
  loading: false,
  error: null,
  selectedWorktreeId: "worktree",
  activeTabId: "one",
  activeProject: null,
  selectedWorktree: null,
  activeTab: null,
  splitRoot,
  focusedPaneId: "pane-right",
  reload: vi.fn(),
  refreshProject: vi.fn(),
  selectProject: vi.fn(),
  selectWorktree: vi.fn(),
  createTerminalTab: vi.fn(),
  createBrowserTab: vi.fn(),
  createTabInPane: vi.fn(),
  openFileTab: vi.fn(),
  openDiffTab: vi.fn(),
  openReviewTab: vi.fn(),
  openDaemonLogTab: vi.fn(),
  closeTab: vi.fn(),
  renameTerminalTab: vi.fn(),
  openSelectedWorktree: vi.fn(),
  openWorktreeInEditor: vi.fn(),
  cycleTab: vi.fn(),
  setActiveTab: vi.fn(),
  getWorktreeStatus: vi.fn(),
  deleteWorktree: vi.fn(),
  renameWorktree: vi.fn(),
  hideWorktree: vi.fn(),
  focusPane: vi.fn(),
  setPaneActiveTab: vi.fn(),
  splitActivePane: vi.fn(),
  splitTabAtPane: vi.fn(),
  moveTabToPane: vi.fn(),
  runScriptsAvailable: false,
  runScriptsConfigError: null,
  runScriptsState: null,
  runScripts: vi.fn(),
  stopRunScripts: vi.fn(),
};

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: (): WorkspaceContextValue => mockWorkspace,
}));

vi.mock("@/components/editor/confirm-close", () => ({
  useConfirmClose: () => vi.fn(),
}));

afterEach(() => {
  cleanup();
  mockWorkspace.splitRootByWorktree = {};
  mockWorkspace.selectedWorktree = null;
  mockWorkspace.runScriptsAvailable = false;
  mockWorkspace.runScriptsState = null;
  vi.clearAllMocks();
});

describe("TerminalTabs", () => {
  it("does not offer the focused pane's active tab as a split candidate", async () => {
    render(<TerminalTabs />);

    const splitButton = screen.getByLabelText("Split horizontal");
    await userEvent.click(splitButton);

    expect(screen.queryByRole("menuitem", { name: "two" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "one" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "three" })).toBeInTheDocument();
  });

  it("collapses a split into a single parent tab named after its top-left pane", () => {
    // pane-left's active tab ("one") is the leading pane → the parent tab's name.
    mockWorkspace.splitRootByWorktree = { worktree: splitRoot };
    render(<TerminalTabs />);

    // The split shows as one parent entry; its members are not separate top tabs.
    expect(screen.getByTitle("Split: one")).toBeInTheDocument();
    expect(screen.queryByText("two")).not.toBeInTheDocument();
    expect(screen.queryByText("three")).not.toBeInTheDocument();
  });

  it("runs project scripts from the header play button", async () => {
    mockWorkspace.selectedWorktree = {
      id: "worktree",
      projectId: "project",
      parentId: null,
      branch: "main",
      title: null,
      path: "/tmp/project",
      isMain: true,
      hidden: false,
      createdAt: "now",
    };
    mockWorkspace.runScriptsAvailable = true;
    render(<TerminalTabs />);

    await userEvent.click(screen.getByLabelText("Run project scripts"));

    expect(mockWorkspace.runScripts).toHaveBeenCalled();
  });

  it("stops managed project scripts while running", async () => {
    mockWorkspace.runScriptsState = {
      worktreeId: "worktree",
      tabIds: ["one"],
      stopping: false,
      splitSnapshot: null,
    };
    render(<TerminalTabs />);

    await userEvent.click(screen.getByLabelText("Stop project scripts"));

    expect(mockWorkspace.stopRunScripts).toHaveBeenCalled();
  });
});
