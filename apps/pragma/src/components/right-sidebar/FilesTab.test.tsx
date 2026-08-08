import type { DirEntry } from "@pragma/constants";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listDirEntriesMock = vi.fn();
const pathExistsMock = vi.fn();
const renameFileMock = vi.fn();
const writeFileBytesMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  listDirEntries: (...args: unknown[]) => listDirEntriesMock(...args),
  createFile: vi.fn(),
  createFolder: vi.fn(),
  deleteFile: vi.fn(),
  pathExists: (...args: unknown[]) => pathExistsMock(...args),
  renameFile: (...args: unknown[]) => renameFileMock(...args),
  writeFileBytes: (...args: unknown[]) => writeFileBytesMock(...args),
}));

vi.mock("@/lib/file-watch", () => ({
  useWorktreeFileChange: () => {},
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({ selectedWorktreeId: "wt", openFileTab: vi.fn() }),
}));

import { FilesTab } from "./FilesTab";

const dirEntry: DirEntry = { name: "src", path: "src", isDir: true };
const fileEntry: DirEntry = { name: "app.ts", path: "src/app.ts", isDir: false };

afterEach(cleanup);
beforeEach(() => {
  listDirEntriesMock.mockReset();
  pathExistsMock.mockReset();
  renameFileMock.mockReset();
  writeFileBytesMock.mockReset();
  listDirEntriesMock.mockImplementation(async (_worktreeId: string, path: string) =>
    path === "" ? [dirEntry] : [fileEntry],
  );
  pathExistsMock.mockResolvedValue(false);
  renameFileMock.mockResolvedValue(undefined);
});

/** A drop payload carrying dragged tree paths (no OS files). */
function pathsTransfer(paths: string[]) {
  return { getData: () => JSON.stringify(paths), types: [], files: [] };
}

async function renderWithSelection() {
  const view = render(<FilesTab />);
  const row = await screen.findByText("src");
  fireEvent.click(row);
  await waitFor(() => expect(screen.getByText("selected: src/")).toBeInTheDocument());
  return view;
}

describe("FilesTab selection", () => {
  it("clears the selection when clicking empty space in the tree", async () => {
    const { container } = await renderWithSelection();
    const tree = container.querySelector(".overflow-auto")!;

    fireEvent.mouseDown(tree);

    await waitFor(() => expect(screen.getByText("selected: /")).toBeInTheDocument());
    expect(screen.getByText("src").closest("button")?.className).not.toContain(
      "outline-primary/60",
    );
  });

  it("clears the selection when clicking outside the Files panel", async () => {
    await renderWithSelection();

    fireEvent.mouseDown(document.body);

    await waitFor(() => expect(screen.getByText("selected: /")).toBeInTheDocument());
  });

  it("keeps the selection when clicking the panel header actions", async () => {
    await renderWithSelection();

    fireEvent.mouseDown(screen.getByLabelText("New File"));

    expect(screen.getByText("selected: src/")).toBeInTheDocument();
  });

  it("keeps the selection when clicking another row", async () => {
    await renderWithSelection();

    fireEvent.mouseDown(screen.getByText("src"));

    expect(screen.getByText("selected: src/")).toBeInTheDocument();
  });
});

async function renderTree() {
  const view = render(<FilesTab />);
  await screen.findByText("src");
  return view.container.querySelector("[data-file-tree-root]")!;
}

describe("FilesTab root drop zone", () => {
  it("moves a dropped entry into the worktree root", async () => {
    const root = await renderTree();

    fireEvent.drop(root, { dataTransfer: pathsTransfer(["src/app.ts"]) });

    await waitFor(() => expect(renameFileMock).toHaveBeenCalledWith("wt", "src/app.ts", "app.ts"));
  });

  it("writes OS files dropped on empty space into the worktree root", async () => {
    const root = await renderTree();
    const file = new File(["hi"], "notes.txt", { type: "text/plain" });

    fireEvent.drop(root, {
      dataTransfer: { getData: () => "", types: ["Files"], files: [file] },
    });

    await waitFor(() =>
      expect(writeFileBytesMock).toHaveBeenCalledWith("wt", "notes.txt", expect.any(String)),
    );
  });

  it("ignores a drop that landed on a row, leaving it to that row", async () => {
    const root = await renderTree();

    fireEvent.drop(screen.getByText("src"), { dataTransfer: pathsTransfer(["other/app.ts"]) });

    expect(root).toBeTruthy();
    expect(renameFileMock).not.toHaveBeenCalledWith("wt", "other/app.ts", "app.ts");
  });

  it("does not move an entry that already sits in the root", async () => {
    const root = await renderTree();

    fireEvent.drop(root, { dataTransfer: pathsTransfer(["src"]) });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renameFileMock).not.toHaveBeenCalled();
  });
});
