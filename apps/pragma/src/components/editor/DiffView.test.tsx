import type { FileChange, Tab } from "@pragma/constants";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fileDiffMock = vi.fn();
const commitFileDiffMock = vi.fn();
const mergeViewMock = vi.fn();
const loadLanguageExtensionMock = vi.fn();
const dispatchMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  fileDiff: (...args: unknown[]) => fileDiffMock(...args),
  commitFileDiff: (...args: unknown[]) => commitFileDiffMock(...args),
}));

// Capture the live-reload listener so tests can simulate watcher events without
// going through the Tauri channel.
let fileChangeListener: ((change: FileChange) => void) | null = null;
vi.mock("@/lib/file-watch", () => ({
  useWorktreeFileChange: (_worktreeId: string, onChange: (change: FileChange) => void) => {
    fileChangeListener = onChange;
  },
}));
vi.mock("@/lib/terminal-manager", () => ({ TERMINAL_FONT_FAMILY: "monospace" }));
vi.mock("@/components/editor/codemirror-language", () => ({
  loadLanguageExtension: (...args: unknown[]) => loadLanguageExtensionMock(...args),
}));
vi.mock("@codemirror/merge", () => ({
  MergeView: class {
    a = { dispatch: dispatchMock };
    b = { dispatch: dispatchMock };
    constructor(config: unknown) {
      mergeViewMock(config);
    }
    destroy() {}
  },
}));

import { DiffView } from "./DiffView";

function diffTab(): Tab {
  return {
    id: "diff-1",
    projectId: "proj",
    worktreeId: "wt",
    kind: "diff",
    title: "app.ts",
    url: null,
    filePath: "src/app.ts",
    diffSide: "committed",
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
  };
}

/** Common resolved diff payload for the tab's `src/app.ts` path. */
function mockAppFileDiff(): void {
  fileDiffMock.mockResolvedValue({
    path: "src/app.ts",
    oldText: "a",
    newText: "b",
    binary: false,
  });
}

afterEach(cleanup);
beforeEach(() => {
  fileChangeListener = null;
  fileDiffMock.mockReset();
  commitFileDiffMock.mockReset();
  mergeViewMock.mockReset();
  loadLanguageExtensionMock.mockReset();
  dispatchMock.mockReset();
  loadLanguageExtensionMock.mockResolvedValue(null);
});

describe("DiffView", () => {
  it("loads the diff for the tab's side and mounts a MergeView", async () => {
    mockAppFileDiff();
    render(<DiffView tab={diffTab()} />);
    await waitFor(() => expect(fileDiffMock).toHaveBeenCalledWith("wt", "src/app.ts", "committed"));
    await waitFor(() => expect(mergeViewMock).toHaveBeenCalled());
  });

  it("loads a commit-scoped diff through commit_file_diff when diffCommit is set", async () => {
    commitFileDiffMock.mockResolvedValue({
      path: "src/app.ts",
      oldText: "a",
      newText: "b",
      binary: false,
    });
    render(<DiffView tab={{ ...diffTab(), diffCommit: "abc123" }} />);
    await waitFor(() =>
      expect(commitFileDiffMock).toHaveBeenCalledWith("wt", "abc123", "src/app.ts"),
    );
    expect(fileDiffMock).not.toHaveBeenCalled();
    await waitFor(() => expect(mergeViewMock).toHaveBeenCalled());
  });

  it("loads the file language grammar through the shared diff renderer", async () => {
    mockAppFileDiff();
    const languageExtension = { sentinel: "language" };
    loadLanguageExtensionMock.mockResolvedValue(languageExtension);

    render(<DiffView tab={diffTab()} />);

    await waitFor(() => expect(loadLanguageExtensionMock).toHaveBeenCalledWith("src/app.ts"));
    await waitFor(() => expect(dispatchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it("recomputes the diff when the watched file changes on disk", async () => {
    mockAppFileDiff();
    render(<DiffView tab={diffTab()} />);
    await waitFor(() => expect(fileDiffMock).toHaveBeenCalledTimes(1));

    fileChangeListener?.({ path: "src/app.ts", kind: "modified" });

    await waitFor(() => expect(fileDiffMock).toHaveBeenCalledTimes(2));
  });

  it("ignores changes to other files", async () => {
    mockAppFileDiff();
    render(<DiffView tab={diffTab()} />);
    await waitFor(() => expect(fileDiffMock).toHaveBeenCalledTimes(1));

    fileChangeListener?.({ path: "src/other.ts", kind: "modified" });

    await Promise.resolve();
    expect(fileDiffMock).toHaveBeenCalledTimes(1);
  });

  it("renders a placeholder for binary diffs without a MergeView", async () => {
    fileDiffMock.mockResolvedValue({
      path: "img.png",
      oldText: "",
      newText: "",
      binary: true,
    });
    render(<DiffView tab={{ ...diffTab(), filePath: "img.png" }} />);
    await screen.findByText(/binary/i);
    expect(mergeViewMock).not.toHaveBeenCalled();
  });
});
