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
  },
}));

import { useWorkspace, WorkspaceProvider } from "./workspace-context";

const project = { id: "proj", name: "proj", path: "/tmp/proj", orderIndex: 0, createdAt: "now" };
const worktree = {
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
    agentId: null,
    userRenamed: false,
    orderIndex: 0,
    createdAt: "now",
    ...overrides,
  };
}

let createdCount: number;

function mockBackend(seedTabs: Tab[]) {
  createdCount = 0;
  invokeMock.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "list_projects":
        return Promise.resolve([project]);
      case "list_worktrees":
        return Promise.resolve([worktree]);
      case "list_tabs":
        return Promise.resolve(seedTabs);
      case "list_splits":
        return Promise.resolve([]);
      case "project_icon":
        return Promise.resolve(null);
      case "create_tab": {
        createdCount += 1;
        return Promise.resolve(
          makeTab({
            id: `created-${createdCount}`,
            kind: args.kind as Tab["kind"],
            title: args.title as string | null,
            filePath: args.filePath as string | null,
            diffSide: args.diffSide as Tab["diffSide"],
          }),
        );
      }
      default:
        return Promise.resolve(undefined);
    }
  });
}

async function renderWorkspace(seedTabs: Tab[]) {
  mockBackend(seedTabs);
  const hook = renderHook(() => useWorkspace(), { wrapper: WorkspaceProvider });
  await waitFor(() => expect(hook.result.current.selectedWorktreeId).toBe("wt-main"));
  await waitFor(() => expect(hook.result.current.tabs.length).toBe(seedTabs.length));
  return hook;
}

describe("openFileTab / openDiffTab", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("focuses an existing editor tab instead of creating a duplicate", async () => {
    const existing = makeTab({ id: "editor-1", kind: "editor", filePath: "src/app.ts" });
    const { result } = await renderWorkspace([existing]);

    await act(async () => {
      await result.current.openFileTab("src/app.ts");
    });

    expect(createdCount).toBe(0);
    expect(result.current.activeTabId).toBe("editor-1");
  });

  it("creates a new editor tab for an unopened file", async () => {
    const { result } = await renderWorkspace([]);

    await act(async () => {
      await result.current.openFileTab("src/new.ts");
    });

    expect(createdCount).toBe(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "create_tab",
      expect.objectContaining({ kind: "editor", filePath: "src/new.ts", diffSide: null }),
    );
  });

  it("dedupes diff tabs by file path and side", async () => {
    const existing = makeTab({
      id: "diff-1",
      kind: "diff",
      filePath: "src/app.ts",
      diffSide: "committed",
    });
    const { result } = await renderWorkspace([existing]);

    // Same side → focus existing.
    await act(async () => {
      await result.current.openDiffTab("src/app.ts", "committed");
    });
    expect(createdCount).toBe(0);
    expect(result.current.activeTabId).toBe("diff-1");

    // Different side → new tab.
    await act(async () => {
      await result.current.openDiffTab("src/app.ts", "unstaged");
    });
    expect(createdCount).toBe(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "create_tab",
      expect.objectContaining({ kind: "diff", filePath: "src/app.ts", diffSide: "unstaged" }),
    );
  });
});
