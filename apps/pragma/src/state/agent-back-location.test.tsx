import type { Tab } from "@pragma/constants";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

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
const worktreeChild = { ...worktreeMain, id: "wt-child", branch: "child", isMain: false };

function makeTab(overrides: Partial<Tab>): Tab {
  return {
    id: "tab",
    projectId: "proj",
    worktreeId: "wt-main",
    kind: "terminal",
    title: null,
    url: null,
    filePath: null,
    diffSide: null,
    prNumber: null,
    pluginId: null,
    pluginViewId: null,
    pluginPayload: null,
    pluginDedupeKey: null,
    userRenamed: false,
    orderIndex: 0,
    createdAt: "now",
    ...overrides,
  };
}

const seedTabs = [
  makeTab({ id: "tab-main", worktreeId: "wt-main" }),
  makeTab({ id: "tab-child", worktreeId: "wt-child" }),
];

function mockBackend() {
  invokeMock.mockImplementation((command: string) => {
    switch (command) {
      case "list_projects":
        return Promise.resolve([project]);
      case "list_worktrees":
        return Promise.resolve([worktreeMain, worktreeChild]);
      case "list_tabs":
        return Promise.resolve(seedTabs);
      case "list_splits":
        return Promise.resolve([]);
      case "project_icon":
        return Promise.resolve(null);
      default:
        return Promise.resolve(undefined);
    }
  });
}

async function renderWorkspace() {
  mockBackend();
  const hook = renderHook(() => useWorkspace(), { wrapper: WorkspaceProvider });
  await waitFor(() => expect(hook.result.current.selectedWorktreeId).toBe("wt-main"));
  // `tabs` is scoped to the selected worktree, so only wt-main's tab is visible.
  await waitFor(() => expect(hook.result.current.tabs.map((tab) => tab.id)).toContain("tab-main"));
  return hook;
}

// Jumps to the child worktree as a notification would, capturing the current
// worktree as the "go back" target.
async function jumpToChildFromMain(result: { current: ReturnType<typeof useWorkspace> }) {
  await act(async () => {
    await result.current.navigateToAgentLocation?.("proj", "wt-child", "tab-child");
  });
}

describe("agent go-back affordance", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("becomes available on the first notification jump without a prior tab switch", async () => {
    const { result } = await renderWorkspace();

    // No explicit set-active-tab has run, so the back target relies on the
    // first-tab fallback in recordBack.
    expect(result.current.agentBackAvailable).toBe(false);
    await jumpToChildFromMain(result);

    expect(result.current.selectedWorktreeId).toBe("wt-child");
    expect(result.current.agentBackAvailable).toBe(true);
  });

  it("clears when the user manually selects another worktree", async () => {
    const { result } = await renderWorkspace();
    await jumpToChildFromMain(result);
    expect(result.current.agentBackAvailable).toBe(true);

    act(() => {
      result.current.selectWorktree("wt-main");
    });

    expect(result.current.agentBackAvailable).toBe(false);
  });

  it("is still consumed by going back via the notification path", async () => {
    const { result } = await renderWorkspace();
    await jumpToChildFromMain(result);
    expect(result.current.agentBackAvailable).toBe(true);

    await act(async () => {
      await result.current.goBackFromAgent?.();
    });

    expect(result.current.selectedWorktreeId).toBe("wt-main");
    expect(result.current.agentBackAvailable).toBe(false);
  });
});
