import type { DirEntry } from "@pragma/constants";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listDirEntriesMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  listDirEntries: (...args: unknown[]) => listDirEntriesMock(...args),
}));

import { FileTree, type FileTreeController, FileTreeNode } from "./FileTreeNode";

function controller(overrides: Partial<FileTreeController> = {}): FileTreeController {
  return {
    worktreeId: "wt",
    selectedDir: "",
    selectDir: vi.fn(),
    selectedFile: "",
    selectFile: vi.fn(),
    isExpanded: () => false,
    toggleExpand: vi.fn(),
    expand: vi.fn(),
    createMode: null,
    beginCreate: vi.fn(),
    cancelCreate: vi.fn(),
    commitCreate: vi.fn(),
    renameMode: null,
    beginRename: vi.fn(),
    cancelRename: vi.fn(),
    commitRename: vi.fn(),
    commitDelete: vi.fn(),
    nonceFor: () => 0,
    openFile: vi.fn(),
    ...overrides,
  };
}

const dirEntry: DirEntry = { name: "src", path: "src", isDir: true };
const fileEntry: DirEntry = { name: "app.ts", path: "src/app.ts", isDir: false };

afterEach(cleanup);
beforeEach(() => {
  listDirEntriesMock.mockReset();
  listDirEntriesMock.mockResolvedValue([]);
});

describe("FileTree", () => {
  it("lazily lists a directory exactly once on mount", async () => {
    listDirEntriesMock.mockResolvedValue([fileEntry]);
    render(<FileTree ctrl={controller()} depth={0} path="src" />);
    await waitFor(() => expect(screen.getByText("app.ts")).toBeInTheDocument());
    expect(listDirEntriesMock).toHaveBeenCalledTimes(1);
    expect(listDirEntriesMock).toHaveBeenCalledWith("wt", "src");
  });

  it("renders the inline create input when creating in this directory", async () => {
    const ctrl = controller({ createMode: { dirPath: "", kind: "file" } });
    render(<FileTree ctrl={ctrl} depth={0} path="" />);
    const input = await screen.findByLabelText("New file name");
    fireEvent.change(input, { target: { value: "new.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ctrl.commitCreate).toHaveBeenCalledWith("", "file", "new.ts");
  });
});

describe("FileTreeNode", () => {
  it("renders the inline rename input when the controller is in rename mode for this row", () => {
    const ctrl = controller({
      renameMode: { path: fileEntry.path, kind: "file", name: fileEntry.name },
    });
    render(<FileTreeNode ctrl={ctrl} depth={0} entry={fileEntry} siblings={[fileEntry.name]} />);
    const input = screen.getByLabelText("Rename file") as HTMLInputElement;
    expect(input.value).toBe("app.ts");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ctrl.commitRename).toHaveBeenCalledWith("src/app.ts", "file", "app.ts");
  });

  it("selects and toggles a directory on click", () => {
    const ctrl = controller();
    render(<FileTreeNode ctrl={ctrl} depth={0} entry={dirEntry} siblings={[dirEntry.name]} />);
    fireEvent.click(screen.getByText("src"));
    expect(ctrl.selectDir).toHaveBeenCalledWith("src");
    expect(ctrl.toggleExpand).toHaveBeenCalledWith("src");
  });

  it("marks a file as selected on click", () => {
    const ctrl = controller();
    render(<FileTreeNode ctrl={ctrl} depth={0} entry={fileEntry} siblings={[fileEntry.name]} />);
    fireEvent.click(screen.getByText("app.ts"));
    expect(ctrl.selectFile).toHaveBeenCalledWith("src/app.ts");
  });

  it("opens a file on double-click", () => {
    const ctrl = controller();
    render(<FileTreeNode ctrl={ctrl} depth={0} entry={fileEntry} siblings={[fileEntry.name]} />);
    fireEvent.doubleClick(screen.getByText("app.ts"));
    expect(ctrl.openFile).toHaveBeenCalledWith("src/app.ts");
  });

  it("does not open a directory on double-click", () => {
    const ctrl = controller();
    render(<FileTreeNode ctrl={ctrl} depth={0} entry={dirEntry} siblings={[dirEntry.name]} />);
    fireEvent.doubleClick(screen.getByText("src"));
    expect(ctrl.openFile).not.toHaveBeenCalled();
  });

  it("applies a distinct visual to the selected file", () => {
    const ctrl = controller({ selectedFile: fileEntry.path });
    render(<FileTreeNode ctrl={ctrl} depth={0} entry={fileEntry} siblings={[fileEntry.name]} />);
    const button = screen.getByText("app.ts").closest("button");
    expect(button?.className).toContain("outline-cyan-400/60");
  });
});
