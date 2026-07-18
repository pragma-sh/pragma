import type { FileChange, Tab } from "@pragma/constants";
import { renderHook, waitFor } from "@testing-library/react";
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

const fileListeners = new Map<string, Set<(change: FileChange) => void>>();

vi.mock("@/lib/file-watch", () => ({
  subscribeToWorktreeFiles: (worktreeId: string, listener: (change: FileChange) => void) => {
    let listeners = fileListeners.get(worktreeId);
    if (!listeners) {
      listeners = new Set();
      fileListeners.set(worktreeId, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  useWorktreeFileChange: () => undefined,
}));

import { useWorkspace, WorkspaceProvider } from "./workspace-context";

function emitFileChange(worktreeId: string, change: FileChange) {
  for (const listener of fileListeners.get(worktreeId) ?? []) {
    listener(change);
  }
}

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

const tab: Tab = {
  id: "tab-main",
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
};

function mockBackend(loadedScripts: () => unknown) {
  invokeMock.mockImplementation((command: string) => {
    switch (command) {
      case "list_projects":
        return Promise.resolve([project]);
      case "list_worktrees":
        return Promise.resolve([worktreeMain]);
      case "list_tabs":
        return Promise.resolve([tab]);
      case "list_splits":
        return Promise.resolve([]);
      case "project_icon":
        return Promise.resolve(null);
      case "load_project_scripts":
        return Promise.resolve(loadedScripts());
      default:
        return Promise.resolve(undefined);
    }
  });
}

function initialLintScripts(): unknown {
  return {
    setup: [],
    runScripts: { lint: { command: ["bun run lint"], icon: null } },
    teardown: [],
  };
}

describe("scripts config live reload", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    fileListeners.clear();
  });

  it("reloads .pragma/scripts.json when it changes in the main worktree", async () => {
    let scripts: unknown = { setup: [], runScripts: {}, teardown: [] };
    mockBackend(() => scripts);
    const { result } = renderHook(() => useWorkspace(), { wrapper: WorkspaceProvider });
    await waitFor(() => expect(result.current.selectedWorktreeId).toBe("wt-main"));
    await waitFor(() =>
      expect(result.current.scriptButtons.map((button) => button.name)).toEqual(["run", "build"]),
    );

    scripts = {
      setup: [],
      runScripts: { lint: { command: ["bun run lint"], icon: null } },
      teardown: [],
    };
    emitFileChange("wt-main", { path: ".pragma/scripts.json", kind: "modified" });

    await waitFor(() =>
      expect(result.current.scriptButtons.map((button) => button.name)).toEqual([
        "run",
        "build",
        "lint",
      ]),
    );
  });

  it("surfaces a broken config edit as an error and drops custom buttons", async () => {
    let scripts: () => unknown = initialLintScripts;
    mockBackend(() => scripts());
    const { result } = renderHook(() => useWorkspace(), { wrapper: WorkspaceProvider });
    await waitFor(() =>
      expect(result.current.scriptButtons.map((button) => button.name)).toEqual([
        "run",
        "build",
        "lint",
      ]),
    );

    scripts = () => Promise.reject(new Error("scripts.json is not valid JSON"));
    emitFileChange("wt-main", { path: ".pragma/scripts.json", kind: "modified" });

    await waitFor(() => expect(result.current.runScriptsConfigError).toContain("not valid JSON"));
    expect(result.current.scriptButtons.map((button) => button.name)).toEqual(["run", "build"]);
  });

  it("ignores changes to unrelated files", async () => {
    let scripts: unknown = { setup: [], runScripts: {}, teardown: [] };
    mockBackend(() => scripts);
    const { result } = renderHook(() => useWorkspace(), { wrapper: WorkspaceProvider });
    await waitFor(() => expect(result.current.selectedWorktreeId).toBe("wt-main"));
    const loadsBefore = invokeMock.mock.calls.filter(
      ([command]) => command === "load_project_scripts",
    ).length;

    scripts = {
      setup: [],
      runScripts: { lint: { command: ["bun run lint"], icon: null } },
      teardown: [],
    };
    emitFileChange("wt-main", { path: "src/main.ts", kind: "modified" });

    await new Promise((resolve) => setTimeout(resolve, 400));
    const loadsAfter = invokeMock.mock.calls.filter(
      ([command]) => command === "load_project_scripts",
    ).length;
    expect(loadsAfter).toBe(loadsBefore);
    expect(result.current.scriptButtons.map((button) => button.name)).toEqual(["run", "build"]);
  });
});
