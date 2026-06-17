import type { Tab } from "@pragma/constants";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
const writeFileMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
}));
vi.mock("@/lib/terminal-manager", () => ({ TERMINAL_FONT_FAMILY: "monospace" }));
vi.mock("@codemirror/language-data", () => ({ languages: [] }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// CodeMirror's DOM measurement is unreliable under jsdom, so back it with a
// plain textarea that forwards edits through the same `onChange` contract.
vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea
      aria-label="editor"
      defaultValue={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

import { EditorView } from "./EditorView";
import { isTabDirty } from "@/state/editor-dirty-store";

function editorTab(): Tab {
  return {
    id: "editor-1",
    projectId: "proj",
    worktreeId: "wt",
    kind: "editor",
    title: "app.ts",
    url: null,
    filePath: "src/app.ts",
    diffSide: null,
    userRenamed: false,
    orderIndex: 0,
    createdAt: "now",
  };
}

afterEach(cleanup);
beforeEach(() => {
  readFileMock.mockReset();
  writeFileMock.mockReset();
  readFileMock.mockResolvedValue({
    path: "src/app.ts",
    text: "hello",
    binary: false,
    truncated: false,
    byteSize: 5,
  });
});

describe("EditorView", () => {
  it("reads the file on mount", async () => {
    render(<EditorView tab={editorTab()} />);
    await waitFor(() => expect(readFileMock).toHaveBeenCalledWith("wt", "src/app.ts"));
    await screen.findByLabelText("editor");
  });

  it("saves on Ctrl-S and clears the dirty flag", async () => {
    writeFileMock.mockResolvedValue(undefined);
    render(<EditorView tab={editorTab()} />);
    const textarea = await screen.findByLabelText("editor");

    fireEvent.change(textarea, { target: { value: "hello world" } });
    await waitFor(() => expect(isTabDirty("editor-1")).toBe(true));

    fireEvent.keyDown(textarea, { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(writeFileMock).toHaveBeenCalledWith("wt", "src/app.ts", "hello world"),
    );
    await waitFor(() => expect(isTabDirty("editor-1")).toBe(false));
  });

  it("stays dirty when the save fails", async () => {
    writeFileMock.mockRejectedValue(new Error("disk full"));
    render(<EditorView tab={editorTab()} />);
    const textarea = await screen.findByLabelText("editor");

    fireEvent.change(textarea, { target: { value: "edited" } });
    fireEvent.keyDown(textarea, { key: "s", ctrlKey: true });
    await waitFor(() => expect(writeFileMock).toHaveBeenCalled());
    expect(isTabDirty("editor-1")).toBe(true);
  });

  it("shows a placeholder for binary files", async () => {
    readFileMock.mockResolvedValue({
      path: "img.png",
      text: "",
      binary: true,
      truncated: false,
      byteSize: 9,
    });
    render(<EditorView tab={{ ...editorTab(), filePath: "img.png" }} />);
    await screen.findByText(/binary/i);
    expect(screen.queryByLabelText("editor")).not.toBeInTheDocument();
  });
});
