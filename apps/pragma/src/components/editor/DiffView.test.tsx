import type { Tab } from "@pragma/constants";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fileDiffMock = vi.fn();
const mergeViewMock = vi.fn();
const loadLanguageExtensionMock = vi.fn();
const dispatchMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  fileDiff: (...args: unknown[]) => fileDiffMock(...args),
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
    prNumber: null,
    userRenamed: false,
    orderIndex: 0,
    createdAt: "now",
  };
}

afterEach(cleanup);
beforeEach(() => {
  fileDiffMock.mockReset();
  mergeViewMock.mockReset();
  loadLanguageExtensionMock.mockReset();
  dispatchMock.mockReset();
  loadLanguageExtensionMock.mockResolvedValue(null);
});

describe("DiffView", () => {
  it("loads the diff for the tab's side and mounts a MergeView", async () => {
    fileDiffMock.mockResolvedValue({
      path: "src/app.ts",
      oldText: "a",
      newText: "b",
      binary: false,
    });
    render(<DiffView tab={diffTab()} />);
    await waitFor(() => expect(fileDiffMock).toHaveBeenCalledWith("wt", "src/app.ts", "committed"));
    await waitFor(() => expect(mergeViewMock).toHaveBeenCalled());
  });

  it("loads the file language grammar through the shared diff renderer", async () => {
    fileDiffMock.mockResolvedValue({
      path: "src/app.ts",
      oldText: "a",
      newText: "b",
      binary: false,
    });
    const languageExtension = { sentinel: "language" };
    loadLanguageExtensionMock.mockResolvedValue(languageExtension);

    render(<DiffView tab={diffTab()} />);

    await waitFor(() => expect(loadLanguageExtensionMock).toHaveBeenCalledWith("src/app.ts"));
    await waitFor(() => expect(dispatchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
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
