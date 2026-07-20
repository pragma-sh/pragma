import type { FileChange, Tab } from "@pragma/constants";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
const writeFileMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
}));

let fileChangeListener: ((change: FileChange) => void) | null = null;
vi.mock("@/lib/file-watch", () => ({
  useWorktreeFileChange: (_worktreeId: string, onChange: (change: FileChange) => void) => {
    fileChangeListener = onChange;
  },
}));
vi.mock("@codemirror/language-data", () => ({ languages: [] }));
// The toolbar reads live formatting state via useEditorState, which the fake
// editor below doesn't implement; it's irrelevant to the re-seed behavior
// under test here.
vi.mock("@/components/editor/MarkdownToolbar", () => ({
  MarkdownToolbar: () => <div aria-label="toolbar" />,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// CodeMirror's DOM measurement is unreliable under jsdom, so back it with a
// plain textarea that forwards edits through the same `onChange` contract.
vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea
      aria-label="raw editor"
      defaultValue={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

// ProseMirror can't lay out under jsdom; stub the TipTap surface with a
// contenteditable placeholder that only proves which mode is mounted.
// `mockEditor` defaults to null (editor still instantiating) and individual
// tests can swap in a fake editor instance to exercise the re-seed effect.
let mockEditor: unknown = null;
vi.mock("@tiptap/react", () => ({
  useEditor: () => mockEditor,
  useEditorState: () => ({}),
  EditorContent: () => <div aria-label="wysiwyg editor" />,
  Extension: { create: (config: unknown) => config },
}));

// The fuzzy-find ProseMirror plugin isn't exercised by these re-seed tests.
vi.mock("@/components/editor/use-markdown-find", () => ({
  markdownFindExtension: {},
  useMarkdownFind: () => ({
    open: false,
    query: "",
    replaceValue: "",
    ignoreCase: false,
    matchCount: 0,
    currentMatch: 0,
    openBar: vi.fn(),
    closeBar: vi.fn(),
    setQuery: vi.fn(),
    setReplaceValue: vi.fn(),
    setIgnoreCase: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    replaceOne: vi.fn(),
    replaceAll: vi.fn(),
  }),
}));

/** A fake TipTap editor exposing just the surface the re-seed effect touches. */
function fakeEditor({
  isFocused = false,
  serializedMarkdown,
}: {
  isFocused?: boolean;
  serializedMarkdown: string;
}) {
  return {
    isFocused,
    storage: { markdown: { getMarkdown: () => serializedMarkdown } },
    commands: { setContent: vi.fn() },
  };
}

import { isMarkdownPath, MarkdownView } from "./MarkdownView";
import { isTabDirty } from "@/state/editor-dirty-store";

function markdownTab(): Tab {
  return {
    id: "md-1",
    projectId: "proj",
    worktreeId: "wt",
    kind: "editor",
    title: "README.md",
    url: null,
    filePath: "README.md",
    diffSide: null,
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

afterEach(cleanup);
beforeEach(() => {
  fileChangeListener = null;
  mockEditor = null;
  readFileMock.mockReset();
  writeFileMock.mockReset();
  readFileMock.mockResolvedValue({
    path: "README.md",
    text: "# Hello",
    binary: false,
    truncated: false,
    byteSize: 7,
  });
});

describe("isMarkdownPath", () => {
  it("matches markdown extensions case-insensitively", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/GUIDE.MD")).toBe(true);
    expect(isMarkdownPath("notes.markdown")).toBe(true);
    expect(isMarkdownPath("notes.mdown")).toBe(true);
  });

  it("rejects non-markdown and JSX-bearing files", () => {
    expect(isMarkdownPath("src/app.ts")).toBe(false);
    expect(isMarkdownPath("page.mdx")).toBe(false);
    expect(isMarkdownPath("md")).toBe(false);
    expect(isMarkdownPath(null)).toBe(false);
  });
});

/** Radix Tabs triggers activate on mousedown, not click. */
function pressTab(element: HTMLElement) {
  fireEvent.mouseDown(element, { button: 0 });
}

describe("MarkdownView", () => {
  it("defaults to the WYSIWYG editor mode after loading the file", async () => {
    render(<MarkdownView tab={markdownTab()} />);
    await waitFor(() => expect(readFileMock).toHaveBeenCalledWith("wt", "README.md"));
    expect(await screen.findByRole("tab", { name: "Editor" })).toBeInTheDocument();
    expect(screen.queryByLabelText("raw editor")).not.toBeInTheDocument();
  });

  it("switches to the raw editor seeded with the loaded document", async () => {
    render(<MarkdownView tab={markdownTab()} />);
    const rawTab = await screen.findByRole("tab", { name: "Raw" });

    pressTab(rawTab);
    const textarea = await screen.findByLabelText("raw editor");
    expect(textarea).toHaveValue("# Hello");
  });

  it("saves raw edits on Ctrl-S and clears the dirty flag", async () => {
    writeFileMock.mockResolvedValue(undefined);
    render(<MarkdownView tab={markdownTab()} />);
    pressTab(await screen.findByRole("tab", { name: "Raw" }));
    const textarea = await screen.findByLabelText("raw editor");

    fireEvent.change(textarea, { target: { value: "# Hello world" } });
    await waitFor(() => expect(isTabDirty("md-1")).toBe(true));

    fireEvent.keyDown(textarea, { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(writeFileMock).toHaveBeenCalledWith("wt", "README.md", "# Hello world"),
    );
    await waitFor(() => expect(isTabDirty("md-1")).toBe(false));
  });

  it("carries unsaved raw edits back into a mode switch", async () => {
    render(<MarkdownView tab={markdownTab()} />);
    pressTab(await screen.findByRole("tab", { name: "Raw" }));
    const textarea = await screen.findByLabelText("raw editor");

    fireEvent.change(textarea, { target: { value: "# Edited" } });
    pressTab(screen.getByRole("tab", { name: "Editor" }));
    pressTab(screen.getByRole("tab", { name: "Raw" }));

    expect(await screen.findByLabelText("raw editor")).toHaveValue("# Edited");
  });

  it("does not reload on external changes while dirty", async () => {
    render(<MarkdownView tab={markdownTab()} />);
    pressTab(await screen.findByRole("tab", { name: "Raw" }));
    const textarea = await screen.findByLabelText("raw editor");
    await waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(1));

    fireEvent.change(textarea, { target: { value: "local edit" } });
    await waitFor(() => expect(isTabDirty("md-1")).toBe(true));
    fileChangeListener?.({ path: "README.md", kind: "modified" });

    await Promise.resolve();
    expect(readFileMock).toHaveBeenCalledTimes(1);
  });

  it("re-seeds a normalized serialization without emitting an update", async () => {
    const editor = fakeEditor({ serializedMarkdown: "# Hello\n" });
    mockEditor = editor;
    render(<MarkdownView tab={markdownTab()} />);

    await waitFor(() => expect(editor.commands.setContent).toHaveBeenCalled());
    expect(editor.commands.setContent).toHaveBeenCalledWith("# Hello", { emitUpdate: false });
    expect(isTabDirty("md-1")).toBe(false);
  });

  it("shows a placeholder for oversized files", async () => {
    readFileMock.mockResolvedValue({
      path: "README.md",
      text: "",
      binary: false,
      truncated: true,
      byteSize: 99,
    });
    render(<MarkdownView tab={markdownTab()} />);
    await screen.findByText(/too large/i);
    expect(screen.queryByRole("tab", { name: "Raw" })).not.toBeInTheDocument();
  });
});
