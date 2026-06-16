import type { Tab } from "@pragma/constants";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SplitHost } from "./SplitHost";
import { TabDragProvider } from "@/components/tabs/tab-drag-context";
import { TAB_DRAG_TYPE } from "@/components/tabs/tab-drag";
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
      selectedProjectId: null,
      selectedWorktreeByProject: {},
      activeTabByWorktree: {},
      splitRootByWorktree: {},
      focusedPaneByWorktree: {},
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
      refreshProject: vi.fn(),
      selectProject: vi.fn(),
      selectWorktree: vi.fn(),
      createTerminalTab: vi.fn(),
      createBrowserTab: vi.fn(),
      createTabInPane,
      openFileTab: vi.fn(),
      openDiffTab: vi.fn(),
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
      focusPane,
      setPaneActiveTab: vi.fn(),
      splitActivePane: vi.fn(),
      splitTabAtPane,
      moveTabToPane,
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
    resize: vi.fn(),
    dispose: vi.fn(),
  },
}));

vi.mock("@/components/editor/confirm-close", () => ({
  useConfirmClose: () => vi.fn(),
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
});

describe("SplitHost", () => {
  it("moves split focus to a pane when its content is clicked", async () => {
    renderHost();

    const rightPane = screen.getByText("two").closest("section");
    expect(rightPane).not.toBeNull();

    await userEvent.click(rightPane!);

    expect(focusPaneMock).toHaveBeenCalledWith("pane-right");
  });

  it("splits the target pane when a tab is dragged onto its content", () => {
    renderHost();

    const sourceTab = screen.getByText("one").closest("[draggable]")!;
    const dataTransfer = tabDataTransfer("one");
    fireEvent.dragStart(sourceTab, { dataTransfer });

    // The drop overlay only exists while a drag is in flight.
    const rightPane = screen.getByText("two").closest("section")!;
    const dropZone = rightPane.querySelector(".z-20")!;
    expect(dropZone).toBeTruthy();

    fireEvent.dragOver(dropZone, { dataTransfer, clientX: 5, clientY: 50 });
    fireEvent.drop(dropZone, { dataTransfer, clientX: 5, clientY: 50 });

    // Exact direction/placement geometry is covered by dropTargetAt's unit tests;
    // here we assert the overlay routes the drop into a split of the target pane.
    expect(splitTabAtPaneMock).toHaveBeenCalledWith(
      "one",
      "pane-right",
      expect.any(String),
      expect.any(String),
    );
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

  it("merges a tab into the pane bar when dropped there", () => {
    renderHost();

    const sourceTab = screen.getByText("one").closest("[draggable]")!;
    const dataTransfer = tabDataTransfer("one");
    fireEvent.dragStart(sourceTab, { dataTransfer });

    const bar = screen.getByText("two").closest("[draggable]")!.parentElement!;
    fireEvent.dragOver(bar, { dataTransfer });
    fireEvent.drop(bar, { dataTransfer });

    expect(moveTabToPaneMock).toHaveBeenCalledWith("one", "pane-right");
  });
});
