import type { Tab } from "@pragma-sh/constants";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const startAgentInTabMock = vi.fn();
const startBackgroundAgentSessionMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class MockChannel<T> {
    onmessage?: (message: T) => void;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/terminal-manager", () => ({
  TERMINAL_FONT_FAMILY: "monospace",
  terminalManager: {
    activate: vi.fn(),
    dispose: vi.fn(),
    mount: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    onTitle: vi.fn(() => () => undefined),
  },
}));
vi.mock("@/lib/agent-launch", () => ({
  startAgentInTab: (...args: unknown[]) => startAgentInTabMock(...args),
  startBackgroundAgentSession: (...args: unknown[]) => startBackgroundAgentSessionMock(...args),
}));

import type { AgentConfig } from "@/lib/tauri";
import { useWorkspace, WorkspaceProvider } from "./workspace-context";

const project = { id: "proj", name: "proj", path: "/tmp/proj", orderIndex: 0, createdAt: "now" };
const worktreeMain = {
  id: "wt-main",
  projectId: "proj",
  parentId: null,
  branch: "main",
  title: null,
  path: "/tmp/proj",
  isMain: true,
  hidden: false,
  createdAt: "now",
};
const worktreeChild = {
  ...worktreeMain,
  id: "wt-child",
  branch: "child",
  path: "/tmp/proj/.pragma/worktrees/child",
  isMain: false,
};

const agent: AgentConfig = {
  id: "agent",
  name: "Agent",
  iconDataUrl: null,
  start: ["agent"],
};

function makeTab(overrides: Partial<Tab>): Tab {
  return {
    id: "tab",
    projectId: "proj",
    worktreeId: "wt-main",
    kind: "terminal",
    title: null,
    url: null,
    filePath: null,
    whiteboardId: null,
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
    ...overrides,
  };
}

/** Creates tabs with the worktree the caller asked for, so dispatch is realistic. */
function mockBackend() {
  let createdCount = 0;
  invokeMock.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "list_projects":
        return Promise.resolve([project]);
      case "list_worktrees":
        return Promise.resolve([worktreeMain, worktreeChild]);
      case "list_tabs":
        return Promise.resolve([]);
      case "list_splits":
        return Promise.resolve([]);
      case "project_icon":
        return Promise.resolve(null);
      case "create_tab": {
        createdCount += 1;
        return Promise.resolve(
          makeTab({
            id: `created-${createdCount}`,
            worktreeId: args.worktreeId as string,
            kind: args.kind as Tab["kind"],
            title: args.title as string | null,
          }),
        );
      }
      default:
        return Promise.resolve(undefined);
    }
  });
}

async function renderWorkspace() {
  mockBackend();
  const hook = renderHook(() => useWorkspace(), { wrapper: WorkspaceProvider });
  await waitFor(() => expect(hook.result.current.selectedWorktreeId).toBe("wt-main"));
  return hook;
}

describe("startSession launch paths", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    startAgentInTabMock.mockReset();
    startBackgroundAgentSessionMock.mockReset();
    startBackgroundAgentSessionMock.mockResolvedValue(undefined);
  });

  it("reveals and mounts the terminal for a foreground launch", async () => {
    const { result } = await renderWorkspace();

    await act(async () => {
      await result.current.startSession("wt-child", agent, "Fix the bug");
    });

    expect(result.current.selectedWorktreeId).toBe("wt-child");
    expect(startAgentInTabMock).toHaveBeenCalledWith("created-1", agent, "Fix the bug", undefined);
    expect(startBackgroundAgentSessionMock).not.toHaveBeenCalled();
  });

  it("spawns the daemon PTY directly for a focus:false launch without a mounted terminal", async () => {
    const { result } = await renderWorkspace();

    await act(async () => {
      await result.current.startSession("wt-child", agent, "Fix the bug", undefined, {
        projectId: "proj",
        focus: false,
        worktreePath: worktreeChild.path,
      });
    });

    expect(startBackgroundAgentSessionMock).toHaveBeenCalledWith(
      "created-1",
      "wt-child",
      worktreeChild.path,
      agent,
      "Fix the bug",
      undefined,
    );
    expect(startAgentInTabMock).not.toHaveBeenCalled();
    // The tab is in the snapshot but not selected: no focus stealing.
    expect(result.current.selectedWorktreeId).toBe("wt-main");
    expect(result.current.projectTabs.map((tab) => tab.id)).toContain("created-1");
  });

  it("still opens a background session when the owner project is not selected", async () => {
    const { result } = await renderWorkspace();
    await act(async () => {
      await result.current.selectProject("other-project");
    });

    let tab: Tab | null = null;
    await act(async () => {
      tab = await result.current.startSession("wt-child", agent, "Fix the bug", undefined, {
        projectId: "proj",
        focus: false,
        worktreePath: worktreeChild.path,
      });
    });

    expect(tab).not.toBeNull();
    expect(startBackgroundAgentSessionMock).toHaveBeenCalledWith(
      "created-1",
      "wt-child",
      worktreeChild.path,
      agent,
      "Fix the bug",
      undefined,
    );
    // The foreign project's snapshot is never polluted with another project's tab.
    expect(result.current.projectTabs.map((item) => item.id)).not.toContain("created-1");
  });
});
