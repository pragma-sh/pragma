import type { ShellProfile, Tab } from "@pragma/constants";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalTabs } from "./TerminalTabs";
import { terminalManager } from "@/lib/terminal-manager";
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
    diffCommit: null,
    prNumber: null,
    pluginId: null,
    pluginViewId: null,
    pluginPayload: null,
    pluginDedupeKey: null,
    agentId: null,
    userRenamed: false,
    orderIndex: 0,
    createdAt: "now",
  };
}

function worktree(): NonNullable<WorkspaceContextValue["selectedWorktree"]> {
  return {
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
  projectTabs: [tab("one"), tab("two"), tab("three")],
  selectedProjectId: null,
  selectedWorktreeByProject: {},
  activeTabByWorktree: { worktree: "one" },
  splitRootByWorktree: {},
  focusedPaneByWorktree: { worktree: "pane-right" },
  remoteWorktrees: {},
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
  startSession: vi.fn(),
  createTabInPane: vi.fn(),
  openFileTab: vi.fn(),
  openDiffTab: vi.fn(),
  openReviewTab: vi.fn(),
  openDaemonLogTab: vi.fn(),
  openPluginWebView: vi.fn(),
  openScratchpadFile: vi.fn(),
  closeTab: vi.fn(),
  renameTerminalTab: vi.fn(),
  markTabAgent: vi.fn(),
  openSelectedWorktree: vi.fn(),
  openWorktreeInEditor: vi.fn(),
  cycleTab: vi.fn(),
  setActiveTab: vi.fn(),
  activateTabLocation: vi.fn(),
  openFileLocation: vi.fn(),
  getWorktreeStatus: vi.fn(),
  deleteWorktree: vi.fn(),
  renameWorktree: vi.fn(),
  hideWorktree: vi.fn(),
  focusPane: vi.fn(),
  setPaneActiveTab: vi.fn(),
  splitActivePane: vi.fn(),
  splitTabAtPane: vi.fn(),
  moveTabToPane: vi.fn(),
  scriptButtons: [
    { name: "run", icon: null, available: false },
    { name: "build", icon: null, available: false },
  ],
  runScriptsConfigError: null,
  activeScripts: [],
  runningScripts: [],
  runScript: vi.fn(),
  stopScript: vi.fn(),
};

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: (): WorkspaceContextValue => mockWorkspace,
}));

vi.mock("@/state/kanban-context", () => ({
  useKanban: () => ({
    mode: "normal",
    openBoard: vi.fn(),
    openSettings: vi.fn(),
    exitBoard: vi.fn(),
  }),
}));

vi.mock("@/state/left-sidebar-context", () => ({
  useLeftSidebar: () => ({ collapsed: false }),
}));

vi.mock("@/components/editor/confirm-close", () => ({
  useConfirmClose: () => vi.fn(),
}));

vi.mock("@/lib/terminal-manager", () => ({
  terminalManager: { focus: vi.fn() },
}));

/** Distributions the WSL probe reports; per-test so both branches are covered. */
let wslDistros: { name: string; running: boolean; version: number; default: boolean }[] = [];
/** The shell Settings → Terminal has selected; null means none configured. */
let configuredDefault: ShellProfile | null = null;

vi.mock("@/hooks/use-wsl-distros", () => ({
  useWslDistros: () => ({ isWindows: wslDistros.length > 0, distros: wslDistros }),
}));

vi.mock("@/hooks/use-terminal-settings", () => ({
  TERMINAL_SETTINGS_CHANGED_EVENT: "pragma:terminal-settings-changed",
  useTerminalSettings: () => ({
    defaultProfile: configuredDefault,
    hiddenDistros: undefined,
  }),
}));

afterEach(() => {
  cleanup();
  wslDistros = [];
  configuredDefault = null;
  mockWorkspace.splitRootByWorktree = {};
  mockWorkspace.selectedWorktree = null;
  mockWorkspace.selectedWorktreeId = "worktree";
  mockWorkspace.remoteWorktrees = {};
  mockWorkspace.scriptButtons = [
    { name: "run", icon: null, available: false },
    { name: "build", icon: null, available: false },
  ];
  mockWorkspace.activeScripts = [];
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

  it("focuses the terminal when its top-level tab is clicked", async () => {
    mockWorkspace.splitRootByWorktree = { worktree: splitRoot };
    render(<TerminalTabs />);

    await userEvent.click(screen.getByTitle("Split: one"));

    expect(mockWorkspace.setActiveTab).toHaveBeenCalledWith("one");
    expect(terminalManager.focus).toHaveBeenCalledWith("one");
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
    mockWorkspace.scriptButtons = [
      { name: "run", icon: null, available: true },
      { name: "build", icon: null, available: false },
    ];
    render(<TerminalTabs />);

    await userEvent.click(screen.getByLabelText("Run project scripts"));

    expect(mockWorkspace.runScript).toHaveBeenCalledWith("run");
  });

  it("disables the editor launcher for remote worktrees", async () => {
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
    mockWorkspace.remoteWorktrees = { worktree: true };
    render(<TerminalTabs />);

    await userEvent.click(screen.getByLabelText(/Open worktree in/));

    expect(screen.getByLabelText(/Open worktree in/)).toBeDisabled();
    expect(screen.getByLabelText("Choose editor")).toBeDisabled();
    expect(mockWorkspace.openSelectedWorktree).not.toHaveBeenCalled();
  });

  it("runs project build scripts from the header hammer button", async () => {
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
    mockWorkspace.scriptButtons = [
      { name: "run", icon: null, available: false },
      { name: "build", icon: null, available: true },
    ];
    render(<TerminalTabs />);

    await userEvent.click(screen.getByLabelText("Build project scripts"));

    expect(mockWorkspace.runScript).toHaveBeenCalledWith("build");
  });

  it("stops managed project scripts while running", async () => {
    mockWorkspace.activeScripts = [{ name: "run", stopping: false }];
    render(<TerminalTabs />);

    await userEvent.click(screen.getByLabelText("Stop project scripts"));

    expect(mockWorkspace.stopScript).toHaveBeenCalledWith("run");
  });

  it("does not show scripts from another worktree as running", () => {
    mockWorkspace.selectedWorktreeId = "other-worktree";
    mockWorkspace.activeScripts = [];
    render(<TerminalTabs />);

    expect(screen.getByLabelText("Run project scripts")).toBeInTheDocument();
    expect(screen.queryByLabelText("Stop project scripts")).not.toBeInTheDocument();
  });

  it("lets a different script start while one is already running", async () => {
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
    mockWorkspace.scriptButtons = [
      { name: "run", icon: null, available: true },
      { name: "build", icon: null, available: true },
    ];
    mockWorkspace.activeScripts = [{ name: "run", stopping: false }];
    render(<TerminalTabs />);

    expect(screen.getByLabelText("Stop project scripts")).not.toBeDisabled();
    const buildButton = screen.getByLabelText("Build project scripts");
    expect(buildButton).not.toBeDisabled();

    await userEvent.click(buildButton);

    expect(mockWorkspace.runScript).toHaveBeenCalledWith("build");
  });

  /// Without WSL there is nothing to choose between, so Terminal must stay a
  /// one-click item rather than becoming a submenu the user has to hover.
  it("opens a terminal directly when no WSL distribution exists", async () => {
    mockWorkspace.selectedWorktree = worktree();
    render(<TerminalTabs />);

    await userEvent.click(screen.getByLabelText("New tab"));
    await userEvent.click(screen.getByText("Terminal"));

    expect(mockWorkspace.createTerminalTab).toHaveBeenCalledWith(undefined, undefined);
  });

  it("nests PowerShell and each distribution under Terminal when WSL exists", async () => {
    mockWorkspace.selectedWorktree = worktree();
    wslDistros = [
      { name: "Ubuntu", running: false, version: 2, default: true },
      { name: "Debian", running: false, version: 2, default: false },
    ];
    render(<TerminalTabs />);

    await userEvent.click(screen.getByLabelText("New tab"));
    await userEvent.click(screen.getByText("Terminal"));

    expect(await screen.findByText("PowerShell")).toBeTruthy();
    expect(screen.getByText("Ubuntu")).toBeTruthy();
    expect(screen.getByText("Debian")).toBeTruthy();
  });

  it("launches the picked distribution rather than the default shell", async () => {
    mockWorkspace.selectedWorktree = worktree();
    wslDistros = [{ name: "Ubuntu", running: false, version: 2, default: true }];
    render(<TerminalTabs />);

    await userEvent.click(screen.getByLabelText("New tab"));
    await userEvent.click(screen.getByText("Terminal"));
    await userEvent.click(await screen.findByText("Ubuntu"));

    expect(mockWorkspace.createTerminalTab).toHaveBeenCalledWith(undefined, {
      backend: "wsl",
      distro: "Ubuntu",
    });
  });

  /// Regression: the badge used to follow `distro.default`, WSL's own default
  /// distribution, so the menu marked Ubuntu as the default even when Settings
  /// had chosen PowerShell.
  it("marks the shell Settings selected, not WSL's own default distribution", async () => {
    mockWorkspace.selectedWorktree = worktree();
    wslDistros = [{ name: "Ubuntu", running: false, version: 2, default: true }];
    configuredDefault = null; // nothing configured → the native shell
    render(<TerminalTabs />);

    await userEvent.click(screen.getByLabelText("New tab"));
    await userEvent.click(screen.getByText("Terminal"));

    const badges = await screen.findAllByText("Default");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.closest("[role='menuitem']")?.textContent).toContain("PowerShell");
  });

  it("moves the badge to the distribution Settings selected", async () => {
    mockWorkspace.selectedWorktree = worktree();
    wslDistros = [
      { name: "Ubuntu", running: false, version: 2, default: true },
      { name: "Debian", running: false, version: 2, default: false },
    ];
    configuredDefault = { backend: "wsl", distro: "Debian" };
    render(<TerminalTabs />);

    await userEvent.click(screen.getByLabelText("New tab"));
    await userEvent.click(screen.getByText("Terminal"));

    const badges = await screen.findAllByText("Default");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.closest("[role='menuitem']")?.textContent).toContain("Debian");
  });

  /// A bare "use WSL's default" configuration names no distribution, so the
  /// badge has to resolve to whichever one WSL actually calls default.
  it("resolves a distro-less WSL default to the distribution WSL names", async () => {
    mockWorkspace.selectedWorktree = worktree();
    wslDistros = [
      { name: "Ubuntu", running: false, version: 2, default: true },
      { name: "Debian", running: false, version: 2, default: false },
    ];
    configuredDefault = { backend: "wsl", distro: null };
    render(<TerminalTabs />);

    await userEvent.click(screen.getByLabelText("New tab"));
    await userEvent.click(screen.getByText("Terminal"));

    const badges = await screen.findAllByText("Default");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.closest("[role='menuitem']")?.textContent).toContain("Ubuntu");
  });

  /// Docker Desktop's VM distributions back other tools and are not usable
  /// interactive shells, so the shipped hide list has to apply to this menu.
  it("omits distributions hidden by the shipped defaults", async () => {
    mockWorkspace.selectedWorktree = worktree();
    wslDistros = [
      { name: "Ubuntu", running: false, version: 2, default: true },
      { name: "docker-desktop", running: false, version: 2, default: false },
    ];
    render(<TerminalTabs />);

    await userEvent.click(screen.getByLabelText("New tab"));
    await userEvent.click(screen.getByText("Terminal"));

    expect(await screen.findByText("Ubuntu")).toBeTruthy();
    expect(screen.queryByText("docker-desktop")).toBeNull();
  });
});
