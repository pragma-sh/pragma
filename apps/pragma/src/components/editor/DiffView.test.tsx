import type { Tab } from "@pragma/constants";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fileDiffMock = vi.fn();
const mergeViewMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  fileDiff: (...args: unknown[]) => fileDiffMock(...args),
}));
vi.mock("@/lib/terminal-manager", () => ({ TERMINAL_FONT_FAMILY: "monospace" }));
vi.mock("@codemirror/merge", () => ({
  MergeView: class {
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
    await waitFor(() => expect(mergeViewMock).toHaveBeenCalledTimes(1));
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
