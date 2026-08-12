import type { Worktree } from "@pragma/constants";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fanoutsMock = vi.fn(() => [] as unknown[]);
const openComparisonMock = vi.fn();
const worktreesMergedStatusMock = vi.fn();
const hideWorktreeMock = vi.fn();
const selectWorktreeMock = vi.fn();
const activateTabLocationMock = vi.fn();
const renameWorktreeMock = vi.fn();
const openWorktreeInEditorMock = vi.fn();
const subscribeToWorktreeFilesMock = vi.fn((_worktreeId: string, _listener: unknown) => vi.fn());

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

let workspaceMock = {
  selectedProjectId: "p",
  selectedWorktreeId: "main",
  worktrees: { p: [mainWorktree, childWorktree] },
  remoteWorktrees: {},
  hideWorktree: hideWorktreeMock,
  openWorktreeInEditor: openWorktreeInEditorMock,
  renameWorktree: renameWorktreeMock,
  selectWorktree: selectWorktreeMock,
  activateTabLocation: activateTabLocationMock,
};

vi.mock("@/lib/tauri", () => ({
  worktreesMergedStatus: (...args: unknown[]) => worktreesMergedStatusMock(...args),
  githubRepoRef: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/file-watch", () => ({
  subscribeToWorktreeFiles: (worktreeId: string, listener: unknown) =>
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  worktreesMergedStatusMock.mockReset();
  hideWorktreeMock.mockReset();
  openWorktreeInEditorMock.mockReset();
  renameWorktreeMock.mockReset();
  selectWorktreeMock.mockReset();
  subscribeToWorktreeFilesMock.mockClear();
  workspaceMock = {
    selectedProjectId: "p",
    selectedWorktreeId: "main",
    worktrees: { p: [mainWorktree, childWorktree] },
    remoteWorktrees: {},
    hideWorktree: hideWorktreeMock,
    openWorktreeInEditor: openWorktreeInEditorMock,
    renameWorktree: renameWorktreeMock,
    selectWorktree: selectWorktreeMock,
    activateTabLocation: activateTabLocationMock,
  };
});

describe("WorktreeTree", () => {
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

  it("does not overlap merged-status interval requests", async () => {
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

    act(() => vi.advanceTimersByTime(6000));
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(1);

    await act(async () => finishRefresh?.({ child: false }));
    act(() => vi.advanceTimersByTime(2000));
    expect(worktreesMergedStatusMock).toHaveBeenCalledTimes(2);
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

  it("shows the new-worktree button on the main worktree row", async () => {
    worktreesMergedStatusMock.mockResolvedValue({ child: false });
    const onCreateChild = vi.fn();

    render(<WorktreeTree onCreateChild={onCreateChild} />);

    const button = await screen.findByRole("button", { name: "New worktree from main" });
    fireEvent.click(button);

    expect(selectWorktreeMock).toHaveBeenCalledWith("main");
    expect(onCreateChild).toHaveBeenCalledOnce();
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

  it("opens an attempt's worktree and agent tab", async () => {
    workspaceMock = { ...workspaceMock, worktrees: { p: [mainWorktree, childWorktree, attempt] } };
    fanoutsMock.mockReturnValue([fanout]);
    worktreesMergedStatusMock.mockResolvedValue({});

    render(<WorktreeTree onCreateChild={vi.fn()} />);
    fireEvent.click(await screen.findByText("opencode · gpt-5.6"));

    expect(activateTabLocationMock).toHaveBeenCalledWith("p", "wt-attempt", "tab-1");
  });

  it("shows no fanout icon for a parent without a fanout", async () => {
    fanoutsMock.mockReturnValue([]);
    worktreesMergedStatusMock.mockResolvedValue({});

    render(<WorktreeTree onCreateChild={vi.fn()} />);

    await screen.findByText("feature");
    expect(screen.queryByRole("button", { name: /Open fanout comparison/ })).toBeNull();
  });
});
