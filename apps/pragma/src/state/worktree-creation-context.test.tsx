import type { Worktree } from "@pragma/constants";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createWorktreeMock = vi.fn();
const githubPullBranchMock = vi.fn();
const startSessionMock = vi.fn();
const refreshProjectMock = vi.fn();
const selectWorktreeMock = vi.fn();
const createTerminalTabMock = vi.fn();
let emitStage: ((stage: { projectId: string; worktreeId: string; stage: string }) => void) | null =
  null;

vi.mock("@/lib/tauri", () => ({
  createWorktree: (...args: unknown[]) => createWorktreeMock(...args),
  githubPullBranch: (...args: unknown[]) => githubPullBranchMock(...args),
  onWorktreeCreateStage: (handler: (stage: never) => void) => {
    emitStage = handler as typeof emitStage;
    return Promise.resolve(() => {
      emitStage = null;
    });
  },
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({
    refreshProject: refreshProjectMock,
    startSession: startSessionMock,
    selectWorktree: selectWorktreeMock,
    createTerminalTab: createTerminalTabMock,
  }),
}));

import { WorktreeCreationScreen } from "@/components/workspace/WorktreeCreationScreen";
import type { AgentConfig } from "@/lib/tauri";
import { useWorktreeCreation, WorktreeCreationProvider } from "./worktree-creation-context";

const newWorktree: Worktree = {
  id: "wt-new",
  projectId: "p",
  parentId: "main",
  branch: "feature",
  title: null,
  path: "/repo/.pragma/worktrees/feature",
  isMain: false,
  hidden: false,
  createdAt: "2026-01-02",
};

const testAgent: AgentConfig = {
  id: "agent",
  name: "Agent",
  iconDataUrl: null,
  start: ["agent"],
};

function withResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Fires a creation on mount so the test only has to assert on the screen. */
function Harness({
  syncWorktreeId,
  prompt = "",
  agent = null,
}: {
  syncWorktreeId: string | null;
  prompt?: string;
  agent?: AgentConfig | null;
}) {
  const { startCreation, creation } = useWorktreeCreation();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          startCreation({
            projectId: "p",
            parentWorktreeId: "main",
            branch: "feature",
            prompt,
            agent,
            syncWorktreeId,
          })
        }
      >
        start
      </button>
      <span data-testid="idle">{creation ? "busy" : "idle"}</span>
      <WorktreeCreationScreen />
    </>
  );
}

function renderHarness(
  syncWorktreeId: string | null = null,
  prompt?: string,
  agent?: AgentConfig | null,
) {
  render(
    <WorktreeCreationProvider>
      <Harness syncWorktreeId={syncWorktreeId} prompt={prompt} agent={agent} />
    </WorktreeCreationProvider>,
  );
  screen.getByRole("button", { name: "start" }).click();
}

/** Holds `createWorktree` open so the screen can be asserted mid-flight. */
function deferCreate() {
  const deferred = withResolvers<Worktree>();
  createWorktreeMock.mockReturnValue(deferred.promise);
  return deferred;
}

describe("WorktreeCreationProvider", () => {
  beforeEach(() => {
    createWorktreeMock.mockResolvedValue(newWorktree);
    githubPullBranchMock.mockResolvedValue(undefined);
    refreshProjectMock.mockResolvedValue(undefined);
    startSessionMock.mockResolvedValue({ id: "tab" });
    createTerminalTabMock.mockResolvedValue({ id: "tab" });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    emitStage = null;
  });

  it("shows only the creating step and clears once the worktree opens", async () => {
    const { resolve } = deferCreate();
    renderHarness();

    expect(await screen.findByRole("heading", { name: "Creating worktree" })).toBeInTheDocument();
    // Heading plus the step row of the same name.
    expect(screen.getAllByText("Creating worktree")).toHaveLength(2);
    expect(screen.queryByText("Syncing base")).not.toBeInTheDocument();
    resolve(newWorktree);
    await waitFor(() =>
      expect(createTerminalTabMock).toHaveBeenCalledWith("wt-new", { projectId: "p" }),
    );
    expect(selectWorktreeMock).toHaveBeenCalledWith("wt-new", "p");
    expect(createTerminalTabMock).toHaveBeenCalledWith("wt-new", { projectId: "p" });
    await waitFor(() => expect(screen.getByTestId("idle")).toHaveTextContent("idle"));
  });

  it("pulls the base first when a sync target is given", async () => {
    const pull = withResolvers<void>();
    githubPullBranchMock.mockReturnValue(pull.promise);
    renderHarness("main");

    expect(await screen.findByText("Syncing base")).toBeInTheDocument();
    expect(createWorktreeMock).not.toHaveBeenCalled();
    pull.resolve();
    await waitFor(() => expect(githubPullBranchMock).toHaveBeenCalledWith("main"));
    await waitFor(() => expect(createWorktreeMock).toHaveBeenCalled());
  });

  it("adds the scripts step when the backend reports setup commands", async () => {
    const { resolve: resolveCreate } = deferCreate();
    renderHarness();

    await waitFor(() => expect(emitStage).not.toBeNull());
    await waitFor(() => expect(createWorktreeMock).toHaveBeenCalled());
    emitStage?.({ projectId: "p", worktreeId: "wt-new", stage: "scripts" });
    expect(await screen.findByText("Running scripts")).toBeInTheDocument();
    resolveCreate(newWorktree);
    await waitFor(() => expect(screen.getByTestId("idle")).toHaveTextContent("idle"));
  });

  it("keeps the screen with an error when creation fails", async () => {
    createWorktreeMock.mockRejectedValue(new Error("branch already exists"));
    renderHarness();

    expect(await screen.findByText("branch already exists")).toBeInTheDocument();
    screen.getByRole("button", { name: "Dismiss" }).click();
    await waitFor(() => expect(screen.getByTestId("idle")).toHaveTextContent("idle"));
  });

  it("keeps the owner project when the selected project changes during creation", async () => {
    renderHarness();

    await waitFor(() => expect(refreshProjectMock).toHaveBeenCalledWith("p"));
    expect(selectWorktreeMock).toHaveBeenCalledWith("wt-new", "p");
    expect(createTerminalTabMock).toHaveBeenCalledWith("wt-new", { projectId: "p" });
  });

  it("keeps the screen and retries when refreshing the created worktree fails", async () => {
    refreshProjectMock.mockRejectedValueOnce(new Error("refresh failed"));
    renderHarness();

    expect(await screen.findByText("refresh failed")).toBeInTheDocument();
    expect(createTerminalTabMock).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "Retry" }).click();
    await waitFor(() =>
      expect(createTerminalTabMock).toHaveBeenCalledWith("wt-new", { projectId: "p" }),
    );
    await waitFor(() => expect(screen.getByTestId("idle")).toHaveTextContent("idle"));
  });

  it("keeps the screen and retries when terminal creation returns no tab", async () => {
    createTerminalTabMock.mockResolvedValueOnce(null);
    renderHarness();

    expect(
      await screen.findByText("Couldn't open a terminal tab for the new worktree."),
    ).toBeInTheDocument();
    screen.getByRole("button", { name: "Retry" }).click();
    await waitFor(() => expect(createTerminalTabMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("idle")).toHaveTextContent("idle"));
  });

  it("keeps the prompt and retries when agent session creation returns no tab", async () => {
    startSessionMock.mockResolvedValueOnce(null);
    renderHarness(null, "Fix the bug", testAgent);

    expect(
      await screen.findByText("Couldn't start an agent session for the new worktree."),
    ).toBeInTheDocument();
    expect(startSessionMock).toHaveBeenCalledWith("wt-new", testAgent, "Fix the bug", undefined, {
      projectId: "p",
    });
    screen.getByRole("button", { name: "Retry" }).click();
    await waitFor(() => expect(startSessionMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("idle")).toHaveTextContent("idle"));
  });
});
