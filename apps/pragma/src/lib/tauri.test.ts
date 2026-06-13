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
});
