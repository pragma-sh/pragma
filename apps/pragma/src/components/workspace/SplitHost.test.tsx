import type { Tab } from "@pragma/constants";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SplitHost } from "./SplitHost";
import { TabDragProvider } from "@/components/tabs/tab-drag-context";
import { TAB_DRAG_TYPE } from "@/components/tabs/tab-drag";
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

const { mockWorkspace, focusPaneMock, splitTabAtPaneMock, moveTabToPaneMock, createTabInPaneMock } =
  vi.hoisted(() => {
    const focusPane = vi.fn();
    const splitTabAtPane = vi.fn();
    const moveTabToPane = vi.fn();
    const createTabInPane = vi.fn();
    const workspace: WorkspaceContextValue = {
      projects: [],
      worktrees: {},
      tabs: [],
      projectTabs: [],
      selectedProjectId: null,
      selectedWorktreeByProject: {},
      activeTabByWorktree: {},
      splitRootByWorktree: {},
      focusedPaneByWorktree: {},
      remoteWorktrees: {},
      icons: {},
      loading: false,
      error: null,
      selectedWorktreeId: "worktree",
      activeTabId: "one",
      activeProject: null,
      selectedWorktree: null,
      activeTab: null,
      splitRoot: {
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
            tabIds: ["two"],
            activeTabId: "two",
          },
        ],
      },
      focusedPaneId: "pane-left",
      reload: vi.fn(),
      clearError: vi.fn(),
      refreshProject: vi.fn(),
      selectProject: vi.fn(),
      selectWorktree: vi.fn(),
      createTerminalTab: vi.fn(),
      createBrowserTab: vi.fn(),
      startSession: vi.fn(),
      createTabInPane,
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
      focusPane,
      setPaneActiveTab: vi.fn(),
      splitActivePane: vi.fn(),
      splitTabAtPane,
      moveTabToPane,
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
    return {
      mockWorkspace: workspace,
      focusPaneMock: focusPane,
      splitTabAtPaneMock: splitTabAtPane,
      moveTabToPaneMock: moveTabToPane,
      createTabInPaneMock: createTabInPane,
    };
  });

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: (): WorkspaceContextValue => mockWorkspace,
}));

vi.mock("@/lib/terminal-manager", () => ({
  TERMINAL_FONT_FAMILY: "monospace",
  terminalManager: {
    mount: vi.fn(),
    activate: vi.fn(),
    focus: vi.fn(),
    setVisible: vi.fn(),
    resize: vi.fn(),
    park: vi.fn(),
    dispose: vi.fn(),
    onRequestFind: vi.fn(() => () => {}),
    getBufferLines: vi.fn(() => []),
    setFuzzyHighlights: vi.fn(),
    clearFuzzyHighlights: vi.fn(),
    scrollToBufferRow: vi.fn(),
    getPendingInputLine: vi.fn(() => ""),
    replaceInPendingInput: vi.fn(),
  },
}));

const requestCloseTabsMock = vi.fn();

vi.mock("@/components/editor/confirm-close", () => ({
  useConfirmClose: () => vi.fn(),
  useConfirmCloseTabs: () => requestCloseTabsMock,
}));

/** Minimal DataTransfer carrying a single tab id, sufficient for the drag handlers. */
function tabDataTransfer(tabId: string) {
  const store: Record<string, string> = { [TAB_DRAG_TYPE]: tabId };
  return {
    types: [TAB_DRAG_TYPE],
    getData: (type: string) => store[type] ?? "",
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    dropEffect: "none",
    effectAllowed: "all",
  };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * jsdom measures everything as 0x0, and the drop resolves purely by geometry, so
 * lay the panes out by hand: two 200x400 panes side by side, each with a 32px bar.
 */
function stubPaneRects() {
  const panes = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]"));
  panes.forEach((pane, index) => {
    const left = index * 200;
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(rect(left, 0, 200, 400));
    const bar = pane.querySelector<HTMLElement>("[data-pane-bar]");
    if (bar) {
      vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(rect(left, 0, 200, 32));
    }
  });
}

/**
 * Dispatch a window-level drag event carrying real coordinates. `fireEvent.dragOver`
 * cannot: jsdom has no `DragEvent`, so testing-library falls back to a plain `Event`
 * and the `clientX`/`clientY` init is dropped.
 */
function fireWindowDrag(
  type: "dragenter" | "dragover" | "drop" | "dragend",
  clientX: number,
  clientY: number,
) {
  act(() => {
    window.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }),
    );
  });
}

function renderHost() {
  mockWorkspace.tabs = [tab("one"), tab("two")];
  return render(
    <TabDragProvider>
      <SplitHost />
    </TabDragProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  focusPaneMock.mockClear();
  splitTabAtPaneMock.mockClear();
  moveTabToPaneMock.mockClear();
  createTabInPaneMock.mockClear();
  vi.mocked(terminalManager.activate).mockClear();
  vi.mocked(terminalManager.focus).mockClear();
  vi.mocked(terminalManager.park).mockClear();
});

describe("SplitHost", () => {
  it("keeps visited terminals mounted when switching tabs in a pane", () => {
    const originalRoot = mockWorkspace.splitRoot;
    const originalActiveTabId = mockWorkspace.activeTabId;
    mockWorkspace.tabs = [tab("one"), tab("two")];
    mockWorkspace.splitRoot = {
      kind: "pane",
      id: "pane-only",
      tabIds: ["one", "two"],
      activeTabId: "one",
    };

    const view = render(
      <TabDragProvider>
        <SplitHost />
      </TabDragProvider>,
    );
    expect(terminalManager.mount).toHaveBeenCalledWith(
      expect.objectContaining({ id: "one" }),
      expect.any(String),
      expect.any(HTMLElement),
    );

    mockWorkspace.activeTabId = "two";
    mockWorkspace.splitRoot = {
      ...mockWorkspace.splitRoot,
      activeTabId: "two",
    };
    view.rerender(
      <TabDragProvider>
        <SplitHost />
      </TabDragProvider>,
    );

    expect(terminalManager.mount).toHaveBeenCalledWith(
      expect.objectContaining({ id: "two" }),
      expect.any(String),
      expect.any(HTMLElement),
    );
    expect(terminalManager.park).not.toHaveBeenCalledWith("one", expect.anything());

    mockWorkspace.splitRoot = originalRoot;
    mockWorkspace.activeTabId = originalActiveTabId;
  });

  it("moves split focus to a pane when its content is clicked", async () => {
    const view = renderHost();
    vi.mocked(terminalManager.focus).mockClear();

    const rightPane = screen.getByText("two").closest("section");
    expect(rightPane).not.toBeNull();

    await userEvent.click(rightPane!);

    expect(focusPaneMock).toHaveBeenCalledWith("pane-right");

    mockWorkspace.focusedPaneId = "pane-right";
    view.rerender(
      <TabDragProvider>
        <SplitHost />
      </TabDragProvider>,
    );
    expect(terminalManager.focus).toHaveBeenCalledWith("two");
    expect(terminalManager.focus).not.toHaveBeenCalledWith("one");
    mockWorkspace.focusedPaneId = "pane-left";
  });

  it("focuses clicked and keyboard-cycled terminal tabs in the focused pane", async () => {
    const originalRoot = mockWorkspace.splitRoot;
    const originalActiveTabId = mockWorkspace.activeTabId;
    const third = tab("three");
    mockWorkspace.tabs = [tab("one"), tab("two"), third];
    mockWorkspace.activeTabId = "one";
    mockWorkspace.focusedPaneId = "pane-left";
    mockWorkspace.splitRoot = {
      kind: "split",
      id: "split-tabs",
      direction: "horizontal",
      children: [
        { kind: "pane", id: "pane-left", tabIds: ["one", "three"], activeTabId: "one" },
        { kind: "pane", id: "pane-right", tabIds: ["two"], activeTabId: "two" },
      ],
    };
    const view = render(
      <TabDragProvider>
        <SplitHost />
      </TabDragProvider>,
    );
    vi.mocked(terminalManager.focus).mockClear();

    await userEvent.click(screen.getByText("three"));
    expect(mockWorkspace.setPaneActiveTab).toHaveBeenCalledWith("pane-left", "three");
    mockWorkspace.activeTabId = "three";
    mockWorkspace.splitRoot = {
      ...mockWorkspace.splitRoot,
      children: [
        { kind: "pane", id: "pane-left", tabIds: ["one", "three"], activeTabId: "three" },
        { kind: "pane", id: "pane-right", tabIds: ["two"], activeTabId: "two" },
      ],
    };
    view.rerender(
      <TabDragProvider>
        <SplitHost />
      </TabDragProvider>,
    );
    expect(terminalManager.focus).toHaveBeenCalledWith("three");

    vi.mocked(terminalManager.focus).mockClear();
    mockWorkspace.activeTabId = "one";
    mockWorkspace.splitRoot = {
      ...mockWorkspace.splitRoot,
      children: [
        { kind: "pane", id: "pane-left", tabIds: ["one", "three"], activeTabId: "one" },
        { kind: "pane", id: "pane-right", tabIds: ["two"], activeTabId: "two" },
      ],
    };
    view.rerender(
      <TabDragProvider>
        <SplitHost />
      </TabDragProvider>,
    );
    expect(terminalManager.focus).toHaveBeenCalledWith("one");
    expect(terminalManager.focus).not.toHaveBeenCalledWith("three");

    mockWorkspace.splitRoot = originalRoot;
    mockWorkspace.activeTabId = originalActiveTabId;
    mockWorkspace.focusedPaneId = "pane-left";
  });

  it("never lets the active terminal in an unfocused split pane steal focus", () => {
    renderHost();

    expect(terminalManager.focus).toHaveBeenCalledWith("one");
    expect(terminalManager.focus).not.toHaveBeenCalledWith("two");
  });

  it("splits the target pane when a tab is dragged onto its content", () => {
    renderHost();
    stubPaneRects();

    const sourceTab = screen.getByText("one").closest("[draggable]")!;
    const dataTransfer = tabDataTransfer("one");
    fireEvent.dragStart(sourceTab, { dataTransfer });

    // Resolution is window-level, not per-pane: the pane is picked by geometry.
    fireWindowDrag("dragover", 205, 50);
    fireWindowDrag("drop", 205, 50);

    // Exact direction/placement geometry is covered by dropTargetAt's unit tests;
    // here we assert the window drop routes into a split of the pane under it.
    expect(splitTabAtPaneMock).toHaveBeenCalledWith(
      "one",
      "pane-right",
      expect.any(String),
      expect.any(String),
    );
  });

  it("previews the split inside the pane under the pointer only", () => {
    renderHost();
    stubPaneRects();

    fireEvent.dragStart(screen.getByText("one").closest("[draggable]")!, {
      dataTransfer: tabDataTransfer("one"),
    });
    fireWindowDrag("dragover", 205, 50);

    const rightPane = screen.getByText("two").closest("section")!;
    const leftPane = screen.getByText("one").closest("section")!;
    // The preview belongs to the section, not the content box: a split divides the
    // whole pane, its bar included.
    expect(rightPane.querySelector(".z-20")?.parentElement).toBe(rightPane);
    expect(leftPane.querySelector(".z-20")).toBeNull();
  });

  it("splits from dragend when WebKit fires no drop event", () => {
    renderHost();
    stubPaneRects();

    fireEvent.dragStart(screen.getByText("one").closest("[draggable]")!, {
      dataTransfer: tabDataTransfer("one"),
    });
    fireWindowDrag("dragover", 300, 380);
    fireWindowDrag("dragend", 300, 380);

    // Bottom of the right pane: released there, so the tab lands below.
    expect(splitTabAtPaneMock).toHaveBeenCalledWith("one", "pane-right", "vertical", "after");
  });

  it("commits nothing when the drag is cancelled with Escape", () => {
    renderHost();
    stubPaneRects();

    fireEvent.dragStart(screen.getByText("one").closest("[draggable]")!, {
      dataTransfer: tabDataTransfer("one"),
    });
    fireWindowDrag("dragover", 205, 380);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    fireWindowDrag("dragend", 0, 0);

    expect(splitTabAtPaneMock).not.toHaveBeenCalled();
    expect(moveTabToPaneMock).not.toHaveBeenCalled();
  });

  it("ignores a drop outside every pane", () => {
    renderHost();
    stubPaneRects();

    const dataTransfer = tabDataTransfer("one");
    fireEvent.dragStart(screen.getByText("one").closest("[draggable]")!, { dataTransfer });
    fireWindowDrag("drop", 900, 900);

    expect(splitTabAtPaneMock).not.toHaveBeenCalled();
    expect(moveTabToPaneMock).not.toHaveBeenCalled();
  });

  it("creates a new tab inside the pane from its + button", async () => {
    renderHost();

    // Each pane bar has its own "+" menu; the right pane's button is the second.
    // Open via keyboard — jsdom's pointer-capture handling doesn't drive the
    // Radix trigger reliably when the pane also listens for pointerdown.
    const addButtons = screen.getAllByRole("button", { name: "New tab in pane" });
    addButtons[1]!.focus();
    await userEvent.keyboard("[Enter]");
    await userEvent.click(await screen.findByText("Browser"));

    expect(createTabInPaneMock).toHaveBeenCalledWith("pane-right", "browser");
  });

  it("closes every tab in a pane from the pane bar's X", async () => {
    renderHost();

    const closeButtons = screen.getAllByRole("button", { name: "Close pane" });
    await userEvent.click(closeButtons[1]!);

    expect(requestCloseTabsMock).toHaveBeenCalledWith([expect.objectContaining({ id: "two" })]);
  });

  it("merges a tab into the pane bar when dropped there", () => {
    renderHost();
    stubPaneRects();

    const sourceTab = screen.getByText("one").closest("[draggable]")!;
    const dataTransfer = tabDataTransfer("one");
    fireEvent.dragStart(sourceTab, { dataTransfer });

    // Inside the right pane's bar band (y < 32) — a merge, not a split.
    fireWindowDrag("dragover", 205, 10);
    fireWindowDrag("drop", 205, 10);

    expect(moveTabToPaneMock).toHaveBeenCalledWith("one", "pane-right");
    expect(splitTabAtPaneMock).not.toHaveBeenCalled();
  });
});
