import type { Tab, Whiteboard } from "@pragma/constants";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  editWhiteboard: vi.fn(),
  getWhiteboard: vi.fn(),
  renameTerminalTab: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  // Captured from the mocked Excalidraw element so tests can assert the
  // composition props WhiteboardView passes for theme/library disabling.
  excalidrawProps: {
    current: {} as Record<string, unknown>,
  },
}));

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: (props: Record<string, unknown>) => {
    mocks.excalidrawProps.current = props;
    const onChange = props.onChange as (
      elements: object[],
      appState: object,
      files: object,
    ) => void;
    return (
      // The real component's root carries the `excalidraw` class; mirroring it
      // keeps wrapper-scoped selectors (whiteboard.css) testable.
      <div className="excalidraw">
        <button onClick={() => onChange([{ id: "one", type: "text" }], {}, {})}>First edit</button>
        <button onClick={() => onChange([{ id: "two", type: "text" }], {}, {})}>Second edit</button>
      </div>
    );
  },
  serializeAsJSON: (
    elements: object[],
    appState: object,
    files: object,
    type: "local" | "database",
  ) =>
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements,
      appState,
      files: type === "local" ? files : undefined,
    }),
}));
vi.mock("@/lib/tauri", () => ({
  editWhiteboard: mocks.editWhiteboard,
  getWhiteboard: mocks.getWhiteboard,
}));
vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({ renameTerminalTab: mocks.renameTerminalTab }),
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, warning: mocks.toastWarning },
}));

import { isTabDirty, setTabDirty } from "@/state/editor-dirty-store";
import { WhiteboardView } from "./WhiteboardView";

const board: Whiteboard = {
  id: "board",
  worktreeId: "worktree",
  title: "Board",
  scene: { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} },
  version: 1,
  createdAt: 1,
  updatedAt: 1,
};

const tab: Tab = {
  id: "tab",
  projectId: "project",
  worktreeId: "worktree",
  kind: "whiteboard",
  title: "Board",
  url: null,
  filePath: null,
  whiteboardId: "board",
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.editWhiteboard.mockReset();
  mocks.getWhiteboard.mockReset().mockResolvedValue(board);
  mocks.renameTerminalTab.mockReset().mockResolvedValue(undefined);
  mocks.toastError.mockReset();
  mocks.toastWarning.mockReset();
  mocks.excalidrawProps.current = {};
  // The dirty store is module state shared across tests; reset the tab.
  setTabDirty("tab", false);
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  vi.useRealTimers();
});

async function settleLoaded(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function editScene(name: "First edit" | "Second edit"): void {
  const button = screen.getByRole("button", { name });
  fireEvent.pointerDown(button);
  fireEvent.click(button);
}

describe("WhiteboardView", () => {
  it("flushes an edit queued behind an in-flight save when unmounted", async () => {
    const first = deferred<Whiteboard>();
    mocks.editWhiteboard
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ...board, version: 3 });
    const rendered = render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    editScene("First edit");
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(mocks.editWhiteboard).toHaveBeenCalledTimes(1);

    editScene("Second edit");
    rendered.unmount();
    await act(async () => {
      first.resolve({ ...board, version: 2 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.editWhiteboard).toHaveBeenCalledTimes(2);
    expect(mocks.editWhiteboard.mock.calls[1]?.[3]).toMatchObject({
      elements: [{ id: "two", type: "text" }],
    });
  });

  it("keeps the tab dirty while a queued save trails an in-flight one", async () => {
    const first = deferred<Whiteboard>();
    const second = deferred<Whiteboard>();
    mocks.editWhiteboard.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    // Edit #1 starts save #1; edit #2 while it is in flight queues save #2.
    editScene("First edit");
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    editScene("Second edit");
    expect(isTabDirty("tab")).toBe(true);

    // Save #1 resolves while save #2 is still queued — the dot must stay up
    // rather than flicker clean during the gap.
    await act(async () => {
      first.resolve({ ...board, version: 2 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.editWhiteboard).toHaveBeenCalledTimes(1);
    expect(isTabDirty("tab")).toBe(true);

    // The queued save runs, stays dirty in flight, and clears only once the
    // pipeline drains.
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(mocks.editWhiteboard).toHaveBeenCalledTimes(2);
    expect(mocks.editWhiteboard.mock.calls[1]?.[3]).toMatchObject({
      elements: [{ id: "two", type: "text" }],
    });
    expect(isTabDirty("tab")).toBe(true);

    await act(async () => {
      second.resolve({ ...board, version: 3 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(isTabDirty("tab")).toBe(false);
  });

  it("recovers from an optimistic conflict instead of stalling every later save", async () => {
    mocks.editWhiteboard
      .mockRejectedValueOnce(new Error("whiteboard changed since version 1"))
      .mockResolvedValueOnce({ ...board, version: 8 });
    // Another writer advanced the board while this canvas held version 1.
    mocks.getWhiteboard
      .mockResolvedValueOnce(board)
      .mockResolvedValueOnce({ ...board, version: 7 });
    render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    editScene("First edit");
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.editWhiteboard.mock.calls[0]?.[4]).toBe(1);
    expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
    expect(isTabDirty("tab")).toBe(true);

    // The queued retry carries the head version, so the save succeeds instead
    // of resending the obsolete one forever.
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.editWhiteboard).toHaveBeenCalledTimes(2);
    expect(mocks.editWhiteboard.mock.calls[1]?.[4]).toBe(7);
    expect(isTabDirty("tab")).toBe(false);
  });

  it("reports a non-conflict save failure without queuing a retry", async () => {
    mocks.editWhiteboard.mockRejectedValue(new Error("host unreachable"));
    render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    editScene("First edit");
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning).not.toHaveBeenCalled();
    expect(isTabDirty("tab")).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(mocks.editWhiteboard).toHaveBeenCalledTimes(1);
  });

  it("does not save redundantly on the authoritative initial load", async () => {
    render(<WhiteboardView tab={tab} />);
    await settleLoaded();
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });

    expect(mocks.editWhiteboard).not.toHaveBeenCalled();
    expect(isTabDirty("tab")).toBe(false);
  });

  it("serializes a self-contained scene with its files", async () => {
    mocks.editWhiteboard.mockResolvedValue({ ...board, version: 2 });
    render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    editScene("First edit");
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(mocks.editWhiteboard.mock.calls[0]?.[3]).toMatchObject({ files: {} });
  });

  it("ignores Excalidraw's programmatic initial change", async () => {
    render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    const onChange = mocks.excalidrawProps.current.onChange as (
      elements: object[],
      appState: object,
      files: object,
    ) => void;
    act(() => onChange(board.scene.elements, board.scene.appState, board.scene.files));
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(mocks.editWhiteboard).not.toHaveBeenCalled();
    expect(isTabDirty("tab")).toBe(false);
  });

  it("persists a rename made on the tab strip to the board title", async () => {
    mocks.editWhiteboard.mockResolvedValue({ ...board, title: "From tab", version: 2 });
    const rendered = render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    rendered.rerender(<WhiteboardView tab={{ ...tab, title: "From tab" }} />);
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });

    expect(mocks.editWhiteboard).toHaveBeenCalledWith(
      "worktree",
      "board",
      "From tab",
      board.scene,
      1,
    );
    // The save's own tab-title sync must not echo the rename back.
    expect(mocks.renameTerminalTab).not.toHaveBeenCalled();
  });

  it("keeps the save in flight dirty when a rename is adopted during the initial load", async () => {
    const loadBoard = deferred<Whiteboard>();
    const saveBoard = deferred<Whiteboard>();
    mocks.getWhiteboard.mockReturnValueOnce(loadBoard.promise);
    mocks.editWhiteboard.mockReturnValueOnce(saveBoard.promise);
    const rendered = render(<WhiteboardView tab={tab} />);

    // Rename on the tab strip while the board is still loading.
    rendered.rerender(<WhiteboardView tab={{ ...tab, title: "Adopted on strip" }} />);

    await act(async () => {
      loadBoard.resolve(board);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The load is ready and the save carrying the adopted rename is in
    // flight — the dirty flag must still be up.
    expect(rendered.container.querySelector(".pragma-whiteboard .excalidraw")).not.toBeNull();
    expect(mocks.editWhiteboard).toHaveBeenCalledWith(
      "worktree",
      "board",
      "Adopted on strip",
      board.scene,
      1,
    );
    expect(isTabDirty("tab")).toBe(true);

    await act(async () => {
      saveBoard.resolve({ ...board, title: "Adopted on strip", version: 2 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(isTabDirty("tab")).toBe(false);
  });

  it("does not re-save when the synced tab title echoes back", async () => {
    mocks.editWhiteboard.mockResolvedValue({ ...board, title: "Renamed", version: 2 });
    const rendered = render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    // A rename made on the tab strip schedules its save…
    rendered.rerender(<WhiteboardView tab={{ ...tab, title: "Renamed" }} />);
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    // …and the workspace reducer delivering the same title back must not
    // schedule a second one.
    rendered.rerender(<WhiteboardView tab={{ ...tab, title: "Renamed", userRenamed: true }} />);
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });

    expect(mocks.editWhiteboard).toHaveBeenCalledTimes(1);
  });

  it("queues a tab rename behind an in-flight save instead of clobbering it", async () => {
    const inFlight = deferred<Whiteboard>();
    mocks.editWhiteboard.mockReturnValueOnce(inFlight.promise);
    const rendered = render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    // An unsaved edit starts save #1; while it is in flight the user renames
    // the tab. Save #1 must not push its older title back onto the tab.
    editScene("First edit");
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    rendered.rerender(<WhiteboardView tab={{ ...tab, title: "Renamed on strip" }} />);
    await act(async () => {
      inFlight.resolve({ ...board, title: "Board", version: 2 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.renameTerminalTab).not.toHaveBeenCalled();
    // The queued rename save still runs.
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(mocks.editWhiteboard).toHaveBeenLastCalledWith(
      "worktree",
      "board",
      "Renamed on strip",
      { ...board.scene, elements: [{ id: "one", type: "text" }] },
      2,
    );
  });

  it("marks the tab dirty for pending saves and clears it after success", async () => {
    mocks.editWhiteboard.mockResolvedValue({ ...board, version: 2 });
    render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    editScene("First edit");
    expect(isTabDirty("tab")).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(isTabDirty("tab")).toBe(false);
  });

  it("flushes a pending edit immediately with Cmd+S", async () => {
    mocks.editWhiteboard.mockResolvedValue({ ...board, version: 2 });
    const { container } = render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    editScene("First edit");
    fireEvent.keyDown(container.querySelector(".pragma-whiteboard")!, {
      key: "s",
      metaKey: true,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.editWhiteboard).toHaveBeenCalledOnce();
    expect(isTabDirty("tab")).toBe(false);
  });

  it("stays saved when Excalidraw repeats the scene after Cmd+S", async () => {
    const save = deferred<Whiteboard>();
    mocks.editWhiteboard.mockReturnValueOnce(save.promise);
    const { container } = render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    editScene("First edit");
    fireEvent.keyDown(container.querySelector(".pragma-whiteboard")!, {
      key: "s",
      metaKey: true,
    });
    const onChange = mocks.excalidrawProps.current.onChange as (
      elements: object[],
      appState: object,
      files: object,
    ) => void;
    act(() => onChange([{ id: "one", type: "text" }], {}, {}));
    await act(async () => {
      save.resolve({ ...board, version: 2 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.editWhiteboard).toHaveBeenCalledOnce();
    expect(isTabDirty("tab")).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
    });
    expect(mocks.editWhiteboard).toHaveBeenCalledOnce();
  });

  it("stays dirty on a save error and retries with Cmd+S", async () => {
    mocks.editWhiteboard
      .mockRejectedValueOnce(new Error("host unreachable"))
      .mockResolvedValueOnce({ ...board, version: 2 });
    render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    editScene("First edit");
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(isTabDirty("tab")).toBe(true);
    // The internal header bar is gone, so there is no dedicated retry UI.
    expect(screen.queryByRole("button", { name: "Retry save" })).not.toBeInTheDocument();
    expect(screen.queryByText("Unsaved")).not.toBeInTheDocument();
    expect(mocks.toastError).toHaveBeenCalledWith("Failed to save whiteboard: host unreachable");

    fireEvent.keyDown(document.querySelector(".pragma-whiteboard")!, {
      key: "s",
      metaKey: true,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(isTabDirty("tab")).toBe(false);
    expect(mocks.editWhiteboard).toHaveBeenCalledTimes(2);
    expect(mocks.editWhiteboard.mock.calls[1]?.[3]).toMatchObject({
      elements: [{ id: "one", type: "text" }],
    });
  });

  it("renders no internal header bar — the canvas starts under the tab strip", async () => {
    mocks.editWhiteboard.mockResolvedValue({ ...board, version: 2 });
    const { container } = render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    expect(container.querySelector(".pragma-whiteboard .excalidraw")).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Whiteboard title" })).not.toBeInTheDocument();
    for (const status of ["Saved", "Saving...", "Unsaved"]) {
      expect(screen.queryByText(status)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Retry save" })).not.toBeInTheDocument();
  });

  it("clears the dirty flag when an unmount-flushed save succeeds", async () => {
    const inFlight = deferred<Whiteboard>();
    mocks.editWhiteboard.mockReturnValueOnce(inFlight.promise);
    const rendered = render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    editScene("First edit");
    rendered.unmount();
    await act(async () => {
      inFlight.resolve({ ...board, version: 2 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.editWhiteboard).toHaveBeenCalledOnce();
    expect(isTabDirty("tab")).toBe(false);
  });

  it("disables Excalidraw's own theme toggle and themes the canvas from the root class", async () => {
    document.documentElement.classList.add("dark");
    render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    expect(mocks.excalidrawProps.current.theme).toBe("dark");
    expect(mocks.excalidrawProps.current.UIOptions).toEqual({
      canvasActions: { loadScene: false, toggleTheme: false },
    });
  });

  it("follows a root theme class change into the light palette", async () => {
    document.documentElement.classList.add("dark");
    render(<WhiteboardView tab={tab} />);
    await settleLoaded();
    expect(mocks.excalidrawProps.current.theme).toBe("dark");

    document.documentElement.classList.remove("dark");
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.excalidrawProps.current.theme).toBe("light");
  });

  it("scopes Excalidraw under the pragma-whiteboard wrapper", async () => {
    const { container } = render(<WhiteboardView tab={tab} />);
    await settleLoaded();

    expect(container.querySelector(".pragma-whiteboard .excalidraw")).not.toBeNull();
  });
});
