import { useEffect, useRef } from "react";

import { EditorView } from "@codemirror/view";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const aiInlineEditMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  aiInlineEdit: (...args: unknown[]) => aiInlineEditMock(...args),
}));
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { useInlineEdit } from "./use-inline-edit";

const DOC = "one\ntwo\nthree\n";

let view: EditorView | null = null;

/** Mounts a real CodeMirror instance wired to the hook, like the editor tabs do. */
function Harness() {
  const viewRef = useRef<EditorView | null>(null);
  const parentRef = useRef<HTMLDivElement | null>(null);
  const inlineEdit = useInlineEdit({ viewRef, worktreeId: "wt", filePath: "src/a.ts" });
  const extensionRef = useRef(inlineEdit.extension);
  extensionRef.current = inlineEdit.extension;

  useEffect(() => {
    const created = new EditorView({
      doc: DOC,
      extensions: [extensionRef.current],
      parent: parentRef.current ?? undefined,
    });
    viewRef.current = created;
    view = created;
    return () => {
      created.destroy();
      viewRef.current = null;
      view = null;
    };
  }, []);

  return (
    <div>
      <div ref={parentRef} />
      {inlineEdit.portals}
    </div>
  );
}

/** Highlights the second line, the way a user would before asking for an edit. */
function selectSecondLine(): void {
  const line = view!.state.doc.line(2);
  view!.dispatch({ selection: { anchor: line.from, head: line.to } });
}

/** Opens the prompt pill with the ⌘/Ctrl+K chord. */
function pressInlineEdit(): void {
  fireEvent.keyDown(view!.contentDOM, { key: "k", ctrlKey: true });
}

async function askFor(instruction: string): Promise<void> {
  const input = await screen.findByLabelText("Describe the edit");
  fireEvent.change(input, { target: { value: instruction } });
  fireEvent.keyDown(input, { key: "Enter" });
}

beforeEach(() => {
  aiInlineEditMock.mockReset();
  aiInlineEditMock.mockResolvedValue({
    summary: "shout the second line",
    edits: [{ oldText: "two", newText: "TWO" }],
  });
});

describe("useInlineEdit", () => {
  it("opens a prompt pill under the selection on ⌘/Ctrl+K", async () => {
    render(<Harness />);
    await waitFor(() => expect(view).not.toBeNull());
    selectSecondLine();
    pressInlineEdit();
    expect(await screen.findByLabelText("Describe the edit")).toBeInTheDocument();
  });

  it("shows an abort control while the request is in flight", async () => {
    let finish:
      | ((value: { summary: string; edits: { oldText: string; newText: string }[] }) => void)
      | undefined;
    aiInlineEditMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Harness />);
    await waitFor(() => expect(view).not.toBeNull());
    selectSecondLine();
    pressInlineEdit();
    await askFor("shout it");

    const abort = await screen.findByRole("button", { name: "Abort edit" });
    expect(abort).toBeInTheDocument();
    expect(screen.getByLabelText("Describe the edit")).toBeDisabled();
    fireEvent.click(abort);

    expect(await screen.findByRole("button", { name: "Submit edit" })).toBeInTheDocument();
    expect(screen.getByLabelText("Describe the edit")).not.toBeDisabled();
    finish?.({ summary: "late", edits: [{ oldText: "two", newText: "TWO" }] });
    await waitFor(() => expect(view!.state.doc.toString()).toBe(DOC));
  });

  it("sends the buffer and the selected line range to the model", async () => {
    render(<Harness />);
    await waitFor(() => expect(view).not.toBeNull());
    selectSecondLine();
    pressInlineEdit();
    await askFor("shout it");

    await waitFor(() =>
      expect(aiInlineEditMock).toHaveBeenCalledWith({
        worktreeId: "wt",
        filePath: "src/a.ts",
        doc: DOC,
        instruction: "shout it",
        startLine: 2,
        endLine: 2,
      }),
    );
  });

  it("shows the old and new lines together with an accept/reject bar", async () => {
    render(<Harness />);
    await waitFor(() => expect(view).not.toBeNull());
    selectSecondLine();
    pressInlineEdit();
    await askFor("shout it");

    await waitFor(() => expect(view!.state.doc.toString()).toBe("one\ntwo\nTWO\nthree\n"));
    expect(await screen.findByRole("button", { name: "Accept change 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject change 1" })).toBeInTheDocument();
    expect(screen.getByText("shout the second line")).toBeInTheDocument();
  });

  it("accepting a hunk keeps the new lines", async () => {
    render(<Harness />);
    await waitFor(() => expect(view).not.toBeNull());
    selectSecondLine();
    pressInlineEdit();
    await askFor("shout it");
    fireEvent.click(await screen.findByRole("button", { name: "Accept change 1" }));

    await waitFor(() => expect(view!.state.doc.toString()).toBe("one\nTWO\nthree\n"));
  });

  it("rejecting a hunk restores the original lines", async () => {
    render(<Harness />);
    await waitFor(() => expect(view).not.toBeNull());
    selectSecondLine();
    pressInlineEdit();
    await askFor("shout it");
    fireEvent.click(await screen.findByRole("button", { name: "Reject change 1" }));

    await waitFor(() => expect(view!.state.doc.toString()).toBe(DOC));
  });

  it("accepts the focused hunk from the keyboard alone", async () => {
    render(<Harness />);
    await waitFor(() => expect(view).not.toBeNull());
    selectSecondLine();
    pressInlineEdit();
    await askFor("shout it");
    await screen.findByRole("button", { name: "Accept change 1" });

    fireEvent.keyDown(view!.contentDOM, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(view!.state.doc.toString()).toBe("one\nTWO\nthree\n"));
  });

  it("Escape during review rejects everything that is left", async () => {
    aiInlineEditMock.mockResolvedValue({
      summary: "shout both",
      edits: [
        { oldText: "one", newText: "ONE" },
        { oldText: "three", newText: "THREE" },
      ],
    });
    render(<Harness />);
    await waitFor(() => expect(view).not.toBeNull());
    selectSecondLine();
    pressInlineEdit();
    await askFor("shout the ends");
    await screen.findByRole("button", { name: "Accept change 1" });

    fireEvent.keyDown(view!.contentDOM, { key: "Escape" });
    await waitFor(() => expect(view!.state.doc.toString()).toBe(DOC));
    expect(screen.queryByRole("button", { name: "Accept change 1" })).not.toBeInTheDocument();
  });

  it("reports a failure in the prompt box instead of touching the buffer", async () => {
    aiInlineEditMock.mockRejectedValue(new Error("no model available"));
    render(<Harness />);
    await waitFor(() => expect(view).not.toBeNull());
    selectSecondLine();
    pressInlineEdit();
    await askFor("shout it");

    expect(await screen.findByText("no model available")).toBeInTheDocument();
    expect(view!.state.doc.toString()).toBe(DOC);
  });

  it("reports edits whose anchors no longer match", async () => {
    aiInlineEditMock.mockResolvedValue({
      summary: "rewrite a line that is not there",
      edits: [{ oldText: "missing line", newText: "x" }],
    });
    render(<Harness />);
    await waitFor(() => expect(view).not.toBeNull());
    selectSecondLine();
    pressInlineEdit();
    await askFor("shout it");

    expect(await screen.findByText("rewrite a line that is not there")).toBeInTheDocument();
    expect(view!.state.doc.toString()).toBe(DOC);
  });
});
