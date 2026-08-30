import type { Worktree } from "@pragma/constants";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyAgentReport,
  clearAllAgentStatuses,
  clearDoneStatusForTab,
} from "@/state/agent-status-store";

const fanoutsMock = vi.fn(() => [] as unknown[]);
const openComparisonMock = vi.fn();
const worktreesMergedStatusMock = vi.fn();
const hideWorktreeMock = vi.fn();
const selectWorktreeMock = vi.fn();
const activateTabLocationMock = vi.fn();
const restoreFanoutTabMock = vi.fn();
const renameWorktreeMock = vi.fn();
const openWorktreeInEditorMock = vi.fn();
const worktreeFileListeners = new Map<string, (change: { path: string }) => void>();
const subscribeToWorktreeFilesMock = vi.fn(
  (worktreeId: string, listener: (change: { path: string }) => void) => {
    worktreeFileListeners.set(worktreeId, listener);
    return vi.fn(() => worktreeFileListeners.delete(worktreeId));
  },
);

const mainWorktree: Worktree = {
  id: "main",
  projectId: "p",
  parentId: null,
  branch: "main",
  title: null,
  path: "/repo",
  isMain: true,
  hidden: false,
  createdAt: "2026-01-01",
};
const childWorktree: Worktree = {
  id: "child",
  projectId: "p",
  parentId: "main",
  branch: "feature",
  title: null,
  path: "/repo/.pragma/worktrees/child",
  isMain: false,
  hidden: false,
  createdAt: "2026-01-02",
};
const siblingWorktree: Worktree = {
  ...childWorktree,
  id: "sibling",
  branch: "other-feature",
  path: "/repo/.pragma/worktrees/sibling",
  createdAt: "2026-01-03",
};

let workspaceMock = {
  selectedProjectId: "p",
  selectedWorktreeId: "main",
  worktrees: { p: [mainWorktree, childWorktree] },
  projectTabs: [],
  remoteWorktrees: {},
  hideWorktree: hideWorktreeMock,
  openWorktreeInEditor: openWorktreeInEditorMock,
  renameWorktree: renameWorktreeMock,
  selectWorktree: selectWorktreeMock,
  activateTabLocation: activateTabLocationMock,
};

vi.mock("@/lib/tauri", () => ({
  worktreesMergedStatus: (...args: unknown[]) => worktreesMergedStatusMock(...args),
  restoreFanoutTab: (...args: unknown[]) => restoreFanoutTabMock(...args),
  githubRepoRef: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/file-watch", () => ({
  subscribeToWorktreeFiles: (worktreeId: string, listener: (change: { path: string }) => void) =>
    subscribeToWorktreeFilesMock(worktreeId, listener),
}));

vi.mock("@/lib/github", () => ({
  findPullRequestForBranch: vi.fn().mockResolvedValue(null),
  pullRequestLifecycle: vi.fn().mockReturnValue(null),
}));

vi.mock("@/state/fanouts-context", () => ({
  useFanouts: () => ({
    fanouts: fanoutsMock(),
    comparingFanoutId: null,
    openComparison: openComparisonMock,
    closeComparison: vi.fn(),
    create: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
    send: vi.fn(),
    pick: vi.fn(),
  }),
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => workspaceMock,
}));

vi.mock("@/state/kanban-context", () => ({
  useKanban: () => ({ exitBoard: vi.fn() }),
}));

vi.mock("@/state/github-context", () => ({
  useGitHub: () => ({ authenticated: false }),
}));

import { WorktreeTree } from "./WorktreeTree";
import { useWorktreeShortcutOrder } from "@/lib/shortcut-hints";

afterEach(() => {
  cleanup();
  clearAllAgentStatuses();
  vi.useRealTimers();
  worktreesMergedStatusMock.mockReset();
  hideWorktreeMock.mockReset();
  openWorktreeInEditorMock.mockReset();
  renameWorktreeMock.mockReset();
  selectWorktreeMock.mockReset();
  activateTabLocationMock.mockReset();
  restoreFanoutTabMock.mockReset();
  restoreFanoutTabMock.mockResolvedValue(undefined);
  subscribeToWorktreeFilesMock.mockClear();
  worktreeFileListeners.clear();
  workspaceMock = {
    selectedProjectId: "p",
    selectedWorktreeId: "main",
    worktrees: { p: [mainWorktree, childWorktree] },
    projectTabs: [],
    remoteWorktrees: {},
    hideWorktree: hideWorktreeMock,
    openWorktreeInEditor: openWorktreeInEditorMock,
    renameWorktree: renameWorktreeMock,
    selectWorktree: selectWorktreeMock,
    activateTabLocation: activateTabLocationMock,
  };
});

describe("WorktreeTree", () => {
  it("publishes shortcut targets in rendered sidebar order", async () => {
    workspaceMock = {
      ...workspaceMock,
      worktrees: { p: [siblingWorktree, childWorktree, mainWorktree] },
    };
    worktreesMergedStatusMock.mockResolvedValue({ child: false, sibling: false });
    const { result } = renderHook(() => useWorktreeShortcutOrder());

    render(<WorktreeTree onCreateChild={vi.fn()} />);

    await vi.waitFor(() => expect(result.current).toEqual(["main", "child", "sibling"]));
  });

  it("uses the merged icon for a child worktree with no remaining changes", async () => {
    worktreesMergedStatusMock.mockResolvedValue({ child: true });

    const { container } = render(<WorktreeTree onCreateChild={vi.fn()} />);

    await screen.findByText("feature");
    await vi.waitFor(() => expect(worktreesMergedStatusMock).toHaveBeenCalledWith(["child"]));
    await vi.waitFor(() => expect(container.querySelector(".lucide-git-merge")).toBeTruthy());
  });

  it("keeps the branch icon for a child worktree with remaining changes", async () => {
    worktreesMergedStatusMock.mockResolvedValue({ child: false });

    const { container } = render(<WorktreeTree onCreateChild={vi.fn()} />);

    await screen.findByText("feature");
    await vi.waitFor(() => expect(worktreesMergedStatusMock).toHaveBeenCalledWith(["child"]));
    expect(container.querySelector(".lucide-git-merge")).toBeNull();
  });

  it("coalesces file invalidations and never overlaps merged-status requests", async () => {
    vi.useFakeTimers();
    let finishRefresh: ((value: Record<string, boolean>) => void) | undefined;
    const pendingRefresh = new Promise<Record<string, boolean>>((resolve) => {
      finishRefresh = resolve;
    });
    worktreesMergedStatusMock
      .mockReturnValueOnce(pendingRefresh)
      .mockResolvedValue({ child: true });

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(1);
    expect(subscribeToWorktreeFilesMock).toHaveBeenCalledWith("main", expect.any(Function));

    act(() => {
      const change = { path: ".pragma/worktrees/child/src/file.ts" };
      worktreeFileListeners.get("main")?.(change);
      worktreeFileListeners.get("main")?.(change);
      vi.advanceTimersByTime(2000);
    });
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(1);

    await act(async () => finishRefresh?.({ child: false }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes only the child identified by a main-root file event", async () => {
    vi.useFakeTimers();
    workspaceMock.worktrees = { p: [mainWorktree, childWorktree, siblingWorktree] };
    worktreesMergedStatusMock
      .mockResolvedValueOnce({ child: false, sibling: false })
      .mockResolvedValueOnce({ child: true });

    const { container } = render(<WorktreeTree onCreateChild={vi.fn()} />);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(worktreesMergedStatusMock).toHaveBeenLastCalledWith(["child", "sibling"]);

    act(() => {
      worktreeFileListeners.get("main")?.({ path: ".pragma/worktrees/child/src/file.ts" });
    });
    await act(async () => vi.advanceTimersByTimeAsync(2000));

    expect(worktreesMergedStatusMock).toHaveBeenLastCalledWith(["child"]);
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll(".lucide-git-merge")).toHaveLength(1);
  });

  it("ignores unrelated changes from the shared main-root watch", async () => {
    vi.useFakeTimers();
    worktreesMergedStatusMock.mockResolvedValue({ child: false });

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    worktreeFileListeners.get("main")?.({ path: "src/main.ts" });
    await act(async () => vi.advanceTimersByTimeAsync(2000));

    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(1);
  });

  it("uses a low-frequency fallback for ref-only changes", async () => {
    vi.useFakeTimers();
    worktreesMergedStatusMock.mockResolvedValue({ child: false });

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(2);
  });

  it("does not postpone the ref-only fallback during file activity", async () => {
    vi.useFakeTimers();
    worktreesMergedStatusMock.mockResolvedValue({ child: false });

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    await act(async () => vi.advanceTimersByTimeAsync(0));

    act(() => {
      worktreeFileListeners.get("main")?.({ path: ".pragma/worktrees/child/src/file.ts" });
    });
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(27_999));
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(3);
    expect(worktreesMergedStatusMock).toHaveBeenLastCalledWith(["child"]);
  });

  it("keeps a queued full fallback authoritative over later file invalidations", async () => {
    vi.useFakeTimers();
    workspaceMock.worktrees = { p: [mainWorktree, childWorktree, siblingWorktree] };
    let finishPartial: ((value: Record<string, boolean>) => void) | undefined;
    const partialRefresh = new Promise<Record<string, boolean>>((resolve) => {
      finishPartial = resolve;
    });
    worktreesMergedStatusMock
      .mockResolvedValueOnce({ child: false, sibling: false })
      .mockReturnValueOnce(partialRefresh)
      .mockResolvedValue({ child: false, sibling: true });

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(28_000));
    act(() => {
      worktreeFileListeners.get("main")?.({ path: ".pragma/worktrees/child/src/file.ts" });
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(worktreesMergedStatusMock).toHaveBeenLastCalledWith(["child"]);

    await act(async () => vi.advanceTimersByTimeAsync(1_750));
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(2);
    await act(async () => finishPartial?.({ child: true }));
    act(() => {
      worktreeFileListeners.get("main")?.({ path: ".pragma/worktrees/sibling/src/file.ts" });
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));

    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(3);
    expect(worktreesMergedStatusMock).toHaveBeenLastCalledWith(["child", "sibling"]);
  });

  it("opens the row context menu on right click", async () => {
    worktreesMergedStatusMock.mockResolvedValue({ child: false });

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    const rowLabel = await screen.findByText("main");

    fireEvent.contextMenu(rowLabel);

    expect(screen.getByRole("menuitem", { name: "Copy worktree path" })).toBeInTheDocument();
  });

  it("disables the editor submenu for remote worktrees", async () => {
    worktreesMergedStatusMock.mockResolvedValue({ child: false });
    workspaceMock.remoteWorktrees = { main: true };

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    const rowLabel = await screen.findByText("main");

    fireEvent.contextMenu(rowLabel);

    expect(screen.getByRole("menuitem", { name: "Open in editor" })).toHaveAttribute(
      "data-disabled",
    );
  });

  it("exposes pin in the context menu and unpins via the pin glyph", async () => {
    localStorage.clear();
    worktreesMergedStatusMock.mockResolvedValue({ child: false });

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    const rowLabel = await screen.findByText("feature");

    fireEvent.contextMenu(rowLabel);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));

    const unpin = await screen.findByRole("button", { name: "Unpin feature" });
    fireEvent.click(unpin);

    expect(screen.queryByRole("button", { name: "Unpin feature" })).toBeNull();
  });
});

describe("WorktreeTree fanout", () => {
  const attempt: Worktree = {
    id: "wt-attempt",
    projectId: "p",
    parentId: "main",
    branch: "fanout/aaaa/bbbb",
    title: null,
    path: "/repo/.pragma/worktrees/wt-attempt",
    isMain: false,
    hidden: false,
    createdAt: "2026-01-03",
  };
  const fanout = {
    id: "f1",
    projectId: "p",
    parentWorktreeId: "main",
    sourceWorktreeId: null,
    ownsParent: false,
    baseCommit: "aaaa1111",
    title: "Token refresh",
    prompt: "Implement token refresh",
    status: "active",
    winningMemberId: null,
    finalizeStage: null,
    createdAt: "2026-01-03",
    updatedAt: "2026-01-03",
    members: [
      {
        id: "m-1",
        ordinal: 0,
        selector: "pragma.opencode",
        catalogAgentId: "pragma.opencode",
        runtimeAgentId: "opencode",
        modelId: "gpt-5.6",
        reasoningId: "high",
        branch: "fanout/aaaa/bbbb",
        worktreeId: "wt-attempt",
        tabId: "tab-1",
        priorTabIds: [],
        status: "running",
        failure: null,
      },
    ],
  };

  afterEach(() => {
    fanoutsMock.mockReturnValue([]);
    cleanup();
    vi.clearAllMocks();
  });

  it("marks the parent row and hides attempts from the ordinary tree", async () => {
    workspaceMock = { ...workspaceMock, worktrees: { p: [mainWorktree, childWorktree, attempt] } };
    fanoutsMock.mockReturnValue([fanout]);
    worktreesMergedStatusMock.mockResolvedValue({});

    render(<WorktreeTree onCreateChild={vi.fn()} />);

    // The parent row carries an icon, not a nested prompt row.
    expect(
      await screen.findByRole("button", { name: "Open fanout comparison for main" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Token refresh")).not.toBeInTheDocument();
    // The attempt hangs directly under the parent, as harness + model — never
    // as its generated branch.
    expect(screen.getByText("opencode · gpt-5.6")).toBeInTheDocument();
    expect(screen.queryByText("fanout/aaaa/bbbb")).not.toBeInTheDocument();
    // An ordinary child worktree is still an ordinary row.
    expect(screen.getByText("feature")).toBeInTheDocument();
  });

  it("opens the comparison from the parent row icon", async () => {
    workspaceMock = { ...workspaceMock, worktrees: { p: [mainWorktree, childWorktree, attempt] } };
    fanoutsMock.mockReturnValue([fanout]);
    worktreesMergedStatusMock.mockResolvedValue({});

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open fanout comparison for main" }));

    expect(openComparisonMock).toHaveBeenCalledWith("f1");
  });

  it("restores and opens an attempt's missing agent tab", async () => {
    let finishRestore: (() => void) | undefined;
    restoreFanoutTabMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRestore = resolve;
      }),
    );
    workspaceMock = { ...workspaceMock, worktrees: { p: [mainWorktree, childWorktree, attempt] } };
    fanoutsMock.mockReturnValue([fanout]);
    worktreesMergedStatusMock.mockResolvedValue({});

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    fireEvent.click(await screen.findByText("opencode · gpt-5.6"));

    expect(selectWorktreeMock).not.toHaveBeenCalled();
    expect(restoreFanoutTabMock).toHaveBeenCalledWith("p", "wt-attempt", "tab-1");
    expect(activateTabLocationMock).not.toHaveBeenCalled();

    await act(async () => finishRestore?.());
    expect(activateTabLocationMock).toHaveBeenCalledWith("p", "wt-attempt", "tab-1");
  });

  it("clears a finished attempt's status dot once its tab is viewed", async () => {
    workspaceMock = { ...workspaceMock, worktrees: { p: [mainWorktree, childWorktree, attempt] } };
    fanoutsMock.mockReturnValue([
      { ...fanout, members: [{ ...fanout.members[0], status: "done" }] },
    ]);
    worktreesMergedStatusMock.mockResolvedValue({});
    applyAgentReport({
      worktreeId: "wt-attempt",
      tabId: "tab-1",
      agent: "opencode",
      status: "done",
    });

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    expect(await screen.findByTitle("Agent done")).toBeInTheDocument();

    act(() => clearDoneStatusForTab("tab-1"));

    expect(screen.queryByTitle("Agent done")).not.toBeInTheDocument();
  });

  it("shows no fanout icon for a parent without a fanout", async () => {
    fanoutsMock.mockReturnValue([]);
    worktreesMergedStatusMock.mockResolvedValue({});

    render(<WorktreeTree onCreateChild={vi.fn()} />);

    await screen.findByText("feature");
    expect(screen.queryByRole("button", { name: /Open fanout comparison/ })).toBeNull();
  });
});
