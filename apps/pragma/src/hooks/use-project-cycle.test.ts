import type { Project } from "@pragma/constants";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspace } from "@/state/workspace-context";

import { useProjectCycle } from "./use-project-cycle";

type WorkspaceContextValue = ReturnType<typeof useWorkspace>;

function project(id: string): Project {
  return { id, name: id, path: `/tmp/${id}`, orderIndex: 0, createdAt: "now" };
}

function wheelEvent(deltaX: number): React.WheelEvent {
  return { deltaX, deltaY: 0, shiftKey: false } as unknown as React.WheelEvent;
}

function touchEvent(clientX: number): React.TouchEvent {
  return { touches: [{ clientX }] } as unknown as React.TouchEvent;
}

function touchEndEvent(clientX: number): React.TouchEvent {
  return { changedTouches: [{ clientX }] } as unknown as React.TouchEvent;
}

const { mockWorkspace, selectProjectMock } = vi.hoisted(() => {
  const selectProject = vi.fn();
  const workspace = {
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
    selectedWorktreeId: null,
    activeTabId: null,
    activeProject: null,
    selectedWorktree: null,
    activeTab: null,
    splitRoot: null,
    focusedPaneId: null,
    reload: vi.fn(),
    refreshProject: vi.fn(),
    selectProject,
    selectWorktree: vi.fn(),
    createTerminalTab: vi.fn(),
    createBrowserTab: vi.fn(),
    createTabInPane: vi.fn(),
    closeTab: vi.fn(),
    renameTerminalTab: vi.fn(),
    openSelectedWorktree: vi.fn(),
    cycleTab: vi.fn(),
    setActiveTab: vi.fn(),
    focusPane: vi.fn(),
    setPaneActiveTab: vi.fn(),
    splitActivePane: vi.fn(),
    splitTabAtPane: vi.fn(),
    moveTabToPane: vi.fn(),
  } as WorkspaceContextValue;
  return { mockWorkspace: workspace, selectProjectMock: selectProject };
});

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => mockWorkspace,
}));

describe("useProjectCycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.clearAllTimers();
    mockWorkspace.projects = [project("a"), project("b"), project("c")];
    mockWorkspace.selectedProjectId = "b";
    selectProjectMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("switches to the next project on a rightward wheel gesture", () => {
    const { result } = renderHook(() => useProjectCycle());

    result.current.onWheel(wheelEvent(100));

    expect(selectProjectMock).toHaveBeenCalledWith("c");
  });

  it("switches to the previous project on a leftward wheel gesture", () => {
    const { result } = renderHook(() => useProjectCycle());

    result.current.onWheel(wheelEvent(-100));

    expect(selectProjectMock).toHaveBeenCalledWith("a");
  });

  it("ignores small wheel movements", () => {
    const { result } = renderHook(() => useProjectCycle());

    result.current.onWheel(wheelEvent(10));

    expect(selectProjectMock).not.toHaveBeenCalled();
  });

  it("switches only once per continuous wheel gesture", () => {
    const { result } = renderHook(() => useProjectCycle());

    result.current.onWheel(wheelEvent(50));
    result.current.onWheel(wheelEvent(50));
    result.current.onWheel(wheelEvent(50));

    expect(selectProjectMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a single flick's decaying momentum (one swipe, one project)", () => {
    const { result } = renderHook(() => useProjectCycle());

    // A flick: crosses the threshold, peaks, then momentum decays — all within
    // the quiet window, so it stays one gesture.
    result.current.onWheel(wheelEvent(50)); // crosses threshold -> switch
    vi.advanceTimersByTime(16);
    result.current.onWheel(wheelEvent(90)); // peak
    vi.advanceTimersByTime(16);
    result.current.onWheel(wheelEvent(70)); // decaying
    vi.advanceTimersByTime(16);
    result.current.onWheel(wheelEvent(40));
    vi.advanceTimersByTime(16);
    result.current.onWheel(wheelEvent(15));

    expect(selectProjectMock).toHaveBeenCalledTimes(1);
  });

  it("starts a new gesture once the wheel goes quiet", () => {
    const { result } = renderHook(() => useProjectCycle());

    result.current.onWheel(wheelEvent(100));
    // Quiet longer than the gesture window: the gesture ends.
    vi.advanceTimersByTime(200);
    result.current.onWheel(wheelEvent(100));

    expect(selectProjectMock).toHaveBeenCalledTimes(2);
  });

  it("detects a separate swipe once momentum has decayed, regardless of strength", () => {
    const { result } = renderHook(() => useProjectCycle());

    // First flick: crosses threshold, peaks, then momentum decays.
    result.current.onWheel(wheelEvent(50)); // switch 1
    vi.advanceTimersByTime(16);
    result.current.onWheel(wheelEvent(90)); // peak
    vi.advanceTimersByTime(16);
    result.current.onWheel(wheelEvent(40)); // decayed below 60% of peak
    vi.advanceTimersByTime(16);
    result.current.onWheel(wheelEvent(15)); // momentum nearly gone
    vi.advanceTimersByTime(16);
    // A new push rises above the decayed momentum (and stays below 60% of the old
    // peak) — a separate swipe even though no quiet gap elapsed.
    result.current.onWheel(wheelEvent(50)); // switch 2

    expect(selectProjectMock).toHaveBeenCalledTimes(2);
  });

  it("reverses immediately on a direction change within a gesture", () => {
    const { result } = renderHook(() => useProjectCycle());

    result.current.onWheel(wheelEvent(100)); // -> next
    result.current.onWheel(wheelEvent(-100)); // reverse -> previous, no quiet gap

    expect(selectProjectMock).toHaveBeenCalledTimes(2);
    expect(selectProjectMock).toHaveBeenLastCalledWith("a");
  });

  it("switches to the next project on a left swipe", () => {
    const { result } = renderHook(() => useProjectCycle());

    result.current.onTouchStart(touchEvent(100));
    result.current.onTouchEnd(touchEndEvent(20));

    expect(selectProjectMock).toHaveBeenCalledWith("c");
  });

  it("switches to the previous project on a right swipe", () => {
    const { result } = renderHook(() => useProjectCycle());

    result.current.onTouchStart(touchEvent(0));
    result.current.onTouchEnd(touchEndEvent(80));

    expect(selectProjectMock).toHaveBeenCalledWith("a");
  });

  it("ignores short swipes", () => {
    const { result } = renderHook(() => useProjectCycle());

    result.current.onTouchStart(touchEvent(0));
    result.current.onTouchEnd(touchEndEvent(30));

    expect(selectProjectMock).not.toHaveBeenCalled();
  });

  it("ignores multi-touch gestures", () => {
    const { result } = renderHook(() => useProjectCycle());

    result.current.onTouchStart({
      touches: [{ clientX: 100 }, { clientX: 110 }],
    } as unknown as React.TouchEvent);
    result.current.onTouchEnd(touchEndEvent(20));

    expect(selectProjectMock).not.toHaveBeenCalled();
  });
});
