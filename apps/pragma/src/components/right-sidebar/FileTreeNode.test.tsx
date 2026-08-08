import type { DirEntry } from "@pragma/constants";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listDirEntriesMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  listDirEntries: (...args: unknown[]) => listDirEntriesMock(...args),
}));

import { FileTree, type FileTreeController, FileTreeNode, SPRING_LOAD_MS } from "./FileTreeNode";

function controller(overrides: Partial<FileTreeController> = {}): FileTreeController {
  return {
    worktreeId: "wt",
    selectedPaths: new Set(),
    selectEntry: vi.fn(),
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
    moveEntries: vi.fn(),
    dropFiles: vi.fn(),
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
    expect(ctrl.selectEntry).toHaveBeenCalled();
    expect(ctrl.toggleExpand).toHaveBeenCalledWith("src");
  });

  it("marks a file as selected on click", () => {
    const ctrl = controller();
    render(<FileTreeNode ctrl={ctrl} depth={0} entry={fileEntry} siblings={[fileEntry.name]} />);
    fireEvent.click(screen.getByText("app.ts"));
    expect(ctrl.selectEntry).toHaveBeenCalled();
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

  it("applies a distinct visual to selected entries", () => {
    const ctrl = controller({ selectedPaths: new Set([fileEntry.path]) });
    render(<FileTreeNode ctrl={ctrl} depth={0} entry={fileEntry} siblings={[fileEntry.name]} />);
    const button = screen.getByText("app.ts").closest("button");
    expect(button?.className).toContain("outline-primary/60");
  });

  it("spring-opens a collapsed folder after hovering it with a drag", () => {
    vi.useFakeTimers();
    try {
      const ctrl = controller();
      render(<FileTreeNode ctrl={ctrl} depth={0} entry={dirEntry} siblings={[dirEntry.name]} />);
      const row = screen.getByText("src").closest("button")!;

      fireEvent.dragOver(row, { dataTransfer: { types: [], dropEffect: "" } });
      vi.advanceTimersByTime(SPRING_LOAD_MS - 1);
      expect(ctrl.expand).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(ctrl.expand).toHaveBeenCalledWith("src");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the spring-open when the drag leaves before the delay", () => {
    vi.useFakeTimers();
    try {
      const ctrl = controller();
      render(<FileTreeNode ctrl={ctrl} depth={0} entry={dirEntry} siblings={[dirEntry.name]} />);
      const row = screen.getByText("src").closest("button")!;

      fireEvent.dragOver(row, { dataTransfer: { types: [], dropEffect: "" } });
      vi.advanceTimersByTime(SPRING_LOAD_MS - 1);
      fireEvent.dragLeave(row);
      vi.advanceTimersByTime(SPRING_LOAD_MS);

      expect(ctrl.expand).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the spring-open timer when the drag crosses onto the row's own label", () => {
    vi.useFakeTimers();
    try {
      const ctrl = controller();
      render(<FileTreeNode ctrl={ctrl} depth={0} entry={dirEntry} siblings={[dirEntry.name]} />);
      const label = screen.getByText("src");
      const row = label.closest("button")!;

      fireEvent.dragOver(row, { dataTransfer: { types: [], dropEffect: "" } });
      vi.advanceTimersByTime(SPRING_LOAD_MS / 2);
      // jsdom's synthetic drag events drop `relatedTarget`, so dispatch a real one.
      fireEvent(row, new MouseEvent("dragleave", { bubbles: true, relatedTarget: label }));
      vi.advanceTimersByTime(SPRING_LOAD_MS / 2);

      expect(ctrl.expand).toHaveBeenCalledWith("src");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spring-open a file or an already-expanded folder", () => {
    vi.useFakeTimers();
    try {
      const ctrl = controller({ isExpanded: () => true });
      render(<FileTreeNode ctrl={ctrl} depth={0} entry={dirEntry} siblings={[dirEntry.name]} />);
      fireEvent.dragOver(screen.getByText("src").closest("button")!, {
        dataTransfer: { types: [], dropEffect: "" },
      });

      const fileCtrl = controller();
      const { container } = render(
        <FileTreeNode ctrl={fileCtrl} depth={0} entry={fileEntry} siblings={[fileEntry.name]} />,
      );
      fireEvent.dragOver(container.querySelector("button")!, {
        dataTransfer: { types: [], dropEffect: "" },
      });

      vi.advanceTimersByTime(SPRING_LOAD_MS * 2);
      expect(ctrl.expand).not.toHaveBeenCalled();
      expect(fileCtrl.expand).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops onto a folder row into that folder", () => {
    const ctrl = controller();
    render(<FileTreeNode ctrl={ctrl} depth={0} entry={dirEntry} siblings={[dirEntry.name]} />);

    fireEvent.drop(screen.getByText("src").closest("button")!, {
      dataTransfer: { getData: () => '["other/a.ts"]', types: [], files: [] },
    });

    expect(ctrl.moveEntries).toHaveBeenCalledWith(["other/a.ts"], "src");
  });

  it("drops onto a file row into the folder that holds it", () => {
    const ctrl = controller();
    render(<FileTreeNode ctrl={ctrl} depth={0} entry={fileEntry} siblings={[fileEntry.name]} />);

    fireEvent.drop(screen.getByText("app.ts").closest("button")!, {
      dataTransfer: { getData: () => '["other/a.ts"]', types: [], files: [] },
    });

    expect(ctrl.moveEntries).toHaveBeenCalledWith(["other/a.ts"], "src");
  });

  it("opens the row context menu on right click", () => {
    render(
      <FileTreeNode ctrl={controller()} depth={0} entry={fileEntry} siblings={[fileEntry.name]} />,
    );

    fireEvent.contextMenu(screen.getByText("app.ts"));

    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
  });
});
