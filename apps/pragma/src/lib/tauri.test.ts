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
  cancelPaletteSearch,
  clearSplitLayout,
  createFile,
  createFolder,
  createPluginWebViewTab,
  createTab,
  deleteFile,
  deleteWorktree,
  fileDiff,
  githubPullBranch,
  githubSyncBranch,
  listDirEntries,
  listWorktreeMru,
  loadProjectScripts,
  listSplits,
  markAgentsSeen,
  mergeWorktreeToParent,
  openWorktree,
  paletteSearch,
  pathExists,
  readAutomationSource,
  readFile,
  renameFile,
  renameWorktree,
  setSplitLayout,
  setTabTitle,
  setWorktreeHidden,
  stageAll,
  stageFile,
  touchWorktreeMru,
  unstageAll,
  unstageFile,
  worktreeChanges,
  worktreesAreRemote,
  worktreesMergedStatus,
  worktreeStatus,
  writeAutomationSource,
  writeFile,
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
      filePath: undefined,
      diffSide: undefined,
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
      filePath: undefined,
      diffSide: undefined,
    });
  });

  it("createTab forwards editor file path", () => {
    void createTab("p", "w", "editor", "app.ts", undefined, "src/app.ts", null);
    expect(invokeMock).toHaveBeenCalledWith("create_tab", {
      projectId: "p",
      worktreeId: "w",
      kind: "editor",
      title: "app.ts",
      url: undefined,
      filePath: "src/app.ts",
      diffSide: null,
    });
  });

  it("createTab forwards diff file path and side", () => {
    void createTab("p", "w", "diff", "app.ts", undefined, "src/app.ts", "committed");
    expect(invokeMock).toHaveBeenCalledWith("create_tab", {
      projectId: "p",
      worktreeId: "w",
      kind: "diff",
      title: "app.ts",
      url: undefined,
      filePath: "src/app.ts",
      diffSide: "committed",
    });
  });

  it("createPluginWebViewTab forwards plugin locator metadata", () => {
    void createPluginWebViewTab({
      projectId: "p",
      worktreeId: "w",
      title: "Report",
      pluginId: "plugin-a",
      pluginViewId: "report",
      pluginPayload: '{"ok":true}',
      pluginDedupeKey: "latest",
    });
    expect(invokeMock).toHaveBeenCalledWith("create_plugin_webview_tab", {
      projectId: "p",
      worktreeId: "w",
      title: "Report",
      pluginId: "plugin-a",
      pluginViewId: "report",
      pluginPayload: '{"ok":true}',
      pluginDedupeKey: "latest",
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

  it("openWorktree passes the worktree id and editor id", () => {
    void openWorktree("wt-1", "vscode");
    expect(invokeMock).toHaveBeenCalledWith("open_worktree", {
      worktreeId: "wt-1",
      editorId: "vscode",
    });
  });

  it("worktreesAreRemote forwards the worktree ids", () => {
    void worktreesAreRemote(["wt-1", "wt-2"]);
    expect(invokeMock).toHaveBeenCalledWith("worktrees_are_remote", {
      worktreeIds: ["wt-1", "wt-2"],
    });
  });
});

describe("worktree IPC wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("forwards worktree MRU operations", () => {
    void touchWorktreeMru("worktree");
    expect(invokeMock).toHaveBeenCalledWith("touch_worktree_mru", {
      worktreeId: "worktree",
    });
    void listWorktreeMru("project");
    expect(invokeMock).toHaveBeenCalledWith("list_worktree_mru", {
      projectId: "project",
    });
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

  it("loadProjectScripts forwards the project id", () => {
    void loadProjectScripts("project-1");
    expect(invokeMock).toHaveBeenCalledWith("load_project_scripts", { projectId: "project-1" });
  });
});

describe("agent IPC wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("markAgentsSeen forwards the tab id", () => {
    void markAgentsSeen("tab-1");
    expect(invokeMock).toHaveBeenCalledWith("mark_agents_seen", { tabId: "tab-1" });
  });
});

describe("split-layout IPC wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("listSplits forwards the project id", () => {
    void listSplits("p");
    expect(invokeMock).toHaveBeenCalledWith("list_splits", { projectId: "p" });
  });

  it("setSplitLayout forwards the worktree id and serialized layout", () => {
    void setSplitLayout("wt-1", '{"kind":"split"}');
    expect(invokeMock).toHaveBeenCalledWith("set_split_layout", {
      worktreeId: "wt-1",
      layout: '{"kind":"split"}',
    });
  });

  it("clearSplitLayout forwards the worktree id", () => {
    void clearSplitLayout("wt-1");
    expect(invokeMock).toHaveBeenCalledWith("clear_split_layout", { worktreeId: "wt-1" });
  });
});

describe("filesystem IPC wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("listDirEntries forwards worktree id and path", () => {
    void listDirEntries("wt-1", "src");
    expect(invokeMock).toHaveBeenCalledWith("list_dir_entries", {
      worktreeId: "wt-1",
      path: "src",
    });
  });

  it("paletteSearch forwards project scope and generation id", () => {
    void paletteSearch("project", "worktree", "search", "palette");
    expect(invokeMock).toHaveBeenCalledWith("palette_search", {
      projectId: "project",
      worktreeId: "worktree",
      searchId: "search",
      query: "palette",
    });
  });

  it("cancelPaletteSearch forwards project and search id", () => {
    void cancelPaletteSearch("project", "search");
    expect(invokeMock).toHaveBeenCalledWith("cancel_palette_search", {
      projectId: "project",
      searchId: "search",
    });
  });

  it("createFile forwards worktree id and path", () => {
    void createFile("wt-1", "src/app.ts");
    expect(invokeMock).toHaveBeenCalledWith("create_file", {
      worktreeId: "wt-1",
      path: "src/app.ts",
    });
  });

  it("createFolder forwards worktree id and path", () => {
    void createFolder("wt-1", "src/lib");
    expect(invokeMock).toHaveBeenCalledWith("create_folder", {
      worktreeId: "wt-1",
      path: "src/lib",
    });
  });

  it("pathExists forwards worktree id and path", () => {
    void pathExists("wt-1", "src/app.ts");
    expect(invokeMock).toHaveBeenCalledWith("path_exists", {
      worktreeId: "wt-1",
      path: "src/app.ts",
    });
  });

  it("readFile forwards worktree id and path", () => {
    void readFile("wt-1", "src/app.ts");
    expect(invokeMock).toHaveBeenCalledWith("read_file", {
      worktreeId: "wt-1",
      path: "src/app.ts",
    });
  });

  it("readAutomationSource forwards automation id", () => {
    void readAutomationSource("automation-1");
    expect(invokeMock).toHaveBeenCalledWith("read_automation_source", {
      id: "automation-1",
    });
  });

  it("writeFile forwards worktree id, path, and contents", () => {
    void writeFile("wt-1", "src/app.ts", "const x = 1;");
    expect(invokeMock).toHaveBeenCalledWith("write_file", {
      worktreeId: "wt-1",
      path: "src/app.ts",
      contents: "const x = 1;",
    });
  });

  it("writeAutomationSource forwards automation id and contents", () => {
    void writeAutomationSource("automation-1", "export default {};");
    expect(invokeMock).toHaveBeenCalledWith("write_automation_source", {
      id: "automation-1",
      contents: "export default {};",
    });
  });

  it("renameFile forwards worktree id, from path, and to path", () => {
    void renameFile("wt-1", "src/old.ts", "src/new.ts");
    expect(invokeMock).toHaveBeenCalledWith("rename_file", {
      worktreeId: "wt-1",
      fromPath: "src/old.ts",
      toPath: "src/new.ts",
    });
  });

  it("deleteFile forwards worktree id and path", () => {
    void deleteFile("wt-1", "src/old.ts");
    expect(invokeMock).toHaveBeenCalledWith("delete_file", {
      worktreeId: "wt-1",
      path: "src/old.ts",
    });
  });
});

describe("git changes IPC wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("worktreeChanges forwards the worktree id", () => {
    void worktreeChanges("wt-1");
    expect(invokeMock).toHaveBeenCalledWith("worktree_changes", { worktreeId: "wt-1" });
  });

  it("worktreesMergedStatus forwards the worktree ids", () => {
    void worktreesMergedStatus(["wt-1", "wt-2"]);
    expect(invokeMock).toHaveBeenCalledWith("worktrees_merged_status", {
      worktreeIds: ["wt-1", "wt-2"],
    });
  });

  it("fileDiff forwards worktree id, path, side, and optional old path", () => {
    void fileDiff("wt-1", "src/app.ts", "committed");
    expect(invokeMock).toHaveBeenCalledWith("file_diff", {
      worktreeId: "wt-1",
      path: "src/app.ts",
      side: "committed",
      oldPath: undefined,
    });
    invokeMock.mockReset();
    void fileDiff("wt-1", "src/new.ts", "unstaged", "src/old.ts");
    expect(invokeMock).toHaveBeenCalledWith("file_diff", {
      worktreeId: "wt-1",
      path: "src/new.ts",
      side: "unstaged",
      oldPath: "src/old.ts",
    });
  });

  it("stageFile and stageAll forward their ids", () => {
    void stageFile("wt-1", "src/app.ts");
    expect(invokeMock).toHaveBeenCalledWith("stage_file", {
      worktreeId: "wt-1",
      path: "src/app.ts",
    });
    invokeMock.mockReset();
    void stageAll("wt-1");
    expect(invokeMock).toHaveBeenCalledWith("stage_all", { worktreeId: "wt-1" });
  });

  it("unstageFile and unstageAll forward their ids", () => {
    void unstageFile("wt-1", "src/new.ts", "src/old.ts");
    expect(invokeMock).toHaveBeenCalledWith("unstage_file", {
      worktreeId: "wt-1",
      path: "src/new.ts",
      oldPath: "src/old.ts",
    });
    invokeMock.mockReset();
    void unstageAll("wt-1");
    expect(invokeMock).toHaveBeenCalledWith("unstage_all", { worktreeId: "wt-1" });
  });

  it("mergeWorktreeToParent forwards the worktree id", () => {
    void mergeWorktreeToParent("wt-1");
    expect(invokeMock).toHaveBeenCalledWith("merge_worktree_to_parent", { worktreeId: "wt-1" });
  });

  it("remote pull and sync forward the worktree id", () => {
    void githubPullBranch("wt-1");
    expect(invokeMock).toHaveBeenCalledWith("github_pull_branch", { worktreeId: "wt-1" });
    invokeMock.mockReset();
    void githubSyncBranch("wt-1");
    expect(invokeMock).toHaveBeenCalledWith("github_sync_branch", { worktreeId: "wt-1" });
  });
});

describe("tab title IPC wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("setTabTitle forwards the tab id and shell-emitted title", () => {
    void setTabTitle("tab-1", "user@host: ~/repo");
    expect(invokeMock).toHaveBeenCalledWith("set_tab_title", {
      tabId: "tab-1",
      title: "user@host: ~/repo",
    });
  });
});
