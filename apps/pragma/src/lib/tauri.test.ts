import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class MockChannel<T> {
    onmessage?: (message: T) => void;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import {
  browserCreate,
  browserNavigate,
  browserScreenshot,
  browserSetBounds,
  createTab,
  deleteWorktree,
  openWorktree,
  renameWorktree,
  setWorktreeHidden,
  worktreeStatus,
} from "./tauri";

describe("browser IPC wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("createTab defaults to a terminal kind", () => {
    void createTab("p", "w");
    expect(invokeMock).toHaveBeenCalledWith("create_tab", {
      projectId: "p",
      worktreeId: "w",
      kind: "terminal",
      title: undefined,
      url: undefined,
    });
  });

  it("createTab forwards browser kind and url", () => {
    void createTab("p", "w", "browser", "New tab", "https://example.com");
    expect(invokeMock).toHaveBeenCalledWith("create_tab", {
      projectId: "p",
      worktreeId: "w",
      kind: "browser",
      title: "New tab",
      url: "https://example.com",
    });
  });

  it("browserCreate spreads bounds alongside the tab id and url", () => {
    void browserCreate("tab-1", "https://example.com", { x: 1, y: 2, width: 3, height: 4 });
    expect(invokeMock).toHaveBeenCalledWith("browser_create", {
      tabId: "tab-1",
      url: "https://example.com",
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });

  it("browserSetBounds spreads bounds", () => {
    void browserSetBounds("tab-1", { x: 5, y: 6, width: 7, height: 8 });
    expect(invokeMock).toHaveBeenCalledWith("browser_set_bounds", {
      tabId: "tab-1",
      x: 5,
      y: 6,
      width: 7,
      height: 8,
    });
  });

  it("browserNavigate passes tab id and url", () => {
    void browserNavigate("tab-1", "https://example.org");
    expect(invokeMock).toHaveBeenCalledWith("browser_navigate", {
      tabId: "tab-1",
      url: "https://example.org",
    });
  });

  it("browserScreenshot passes only the bounds", () => {
    void browserScreenshot({ x: 1, y: 2, width: 3, height: 4 });
    expect(invokeMock).toHaveBeenCalledWith("browser_screenshot", {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });

  it("openWorktree passes the worktree path and editor id", () => {
    void openWorktree("/tmp/project", "vscode");
    expect(invokeMock).toHaveBeenCalledWith("open_worktree", {
      path: "/tmp/project",
      editorId: "vscode",
    });
  });
});

describe("worktree IPC wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("worktreeStatus forwards the worktree id", () => {
    void worktreeStatus("wt-1");
    expect(invokeMock).toHaveBeenCalledWith("worktree_status", { worktreeId: "wt-1" });
  });

  it("renameWorktree trims and nulls an empty title", () => {
    void renameWorktree("wt-1", "  New title  ");
    expect(invokeMock).toHaveBeenCalledWith("rename_worktree", {
      worktreeId: "wt-1",
      title: "New title",
    });
    invokeMock.mockReset();
    void renameWorktree("wt-1", "   ");
    expect(invokeMock).toHaveBeenCalledWith("rename_worktree", {
      worktreeId: "wt-1",
      title: null,
    });
  });

  it("setWorktreeHidden forwards the boolean", () => {
    void setWorktreeHidden("wt-1", true);
    expect(invokeMock).toHaveBeenCalledWith("hide_worktree", {
      worktreeId: "wt-1",
      hidden: true,
    });
  });

  it("deleteWorktree forwards branch and force flags", () => {
    void deleteWorktree("wt-1", true, false);
    expect(invokeMock).toHaveBeenCalledWith("delete_worktree", {
      worktreeId: "wt-1",
      deleteBranch: true,
      force: false,
    });
  });
});
