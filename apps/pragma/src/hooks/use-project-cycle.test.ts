import type { Project } from "@pragma/constants";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
    icons: {},
    loading: false,
    error: null,
    selectedWorktreeId: null,
    activeTabId: null,
    activeProject: null,
    selectedWorktree: null,
    activeTab: null,
    reload: vi.fn(),
    refreshProject: vi.fn(),
    selectProject,
    selectWorktree: vi.fn(),
    createTerminalTab: vi.fn(),
    closeTerminalTab: vi.fn(),
    cycleTab: vi.fn(),
    setActiveTab: vi.fn(),
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

  it("respects the cooldown between switches", () => {
    const { result } = renderHook(() => useProjectCycle());

    result.current.onWheel(wheelEvent(100));
    result.current.onWheel(wheelEvent(100));

    expect(selectProjectMock).toHaveBeenCalledTimes(1);
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
});
