import { useRef } from "react";

import type { FileChange, Tab } from "@pragma/constants";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useEditorFileLoader, useEditorOnChange } from "./use-editor-file";
import { disposeTab, isTabDirty, setTabDirty } from "@/state/editor-dirty-store";

function tab(): Tab {
  return {
    id: "pad-1",
    projectId: "proj",
    worktreeId: "wt",
    kind: "scratchpad",
    title: "Pad",
    url: null,
    filePath: ".pragma/scratchpads/pad.mdx",
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

function contents(text: string) {
  return {
    path: ".pragma/scratchpads/pad.mdx",
    text,
    binary: false,
    truncated: false,
    byteSize: text.length,
  };
}

/** Renders the loader and projects its whole result into the DOM for assertions. */
function Probe() {
  const savedDocRef = useRef("");
  const currentDocRef = useRef("");
  const { state, externalChange, reloadFromDisk } = useEditorFileLoader(
    tab(),
    savedDocRef,
    currentDocRef,
  );
  const onChange = useEditorOnChange("pad-1", savedDocRef, currentDocRef);
  return (
    <div>
      <span data-testid="kind">{state.kind}</span>
      <span data-testid="doc">{state.kind === "ready" ? state.doc : ""}</span>
      <span data-testid="external">{String(externalChange)}</span>
      <button onClick={reloadFromDisk} type="button">
        reload
      </button>
      <button onClick={() => onChange("edited")} type="button">
        edit
      </button>
      <button onClick={() => onChange("first")} type="button">
        revert
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  disposeTab("pad-1");
});

beforeEach(() => {
  fileChangeListener = null;
  readFileMock.mockReset();
  writeFileMock.mockReset();
  readFileMock.mockResolvedValue(contents("first"));
});

describe("useEditorFileLoader", () => {
  it("applies an external change in place, without dropping to the loading state", async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("doc")).toHaveTextContent("first"));

    readFileMock.mockResolvedValue(contents("second"));
    await act(async () => {
      fileChangeListener?.({ path: ".pragma/scratchpads/pad.mdx", kind: "modified" });
    });

    expect(screen.getByTestId("doc")).toHaveTextContent("second");
    // Never showed the placeholder, so the surface (and its editor) stayed mounted.
    expect(screen.getByTestId("kind")).toHaveTextContent("ready");
  });

  it("ignores changes to other files", async () => {
    render(<Probe />);
    await waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      fileChangeListener?.({ path: "src/other.ts", kind: "modified" });
    });

    expect(readFileMock).toHaveBeenCalledTimes(1);
  });

  it("flags, rather than applies, an external change while the tab is dirty", async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("doc")).toHaveTextContent("first"));
    act(() => setTabDirty("pad-1", true));

    readFileMock.mockResolvedValue(contents("second"));
    await act(async () => {
      fileChangeListener?.({ path: ".pragma/scratchpads/pad.mdx", kind: "modified" });
    });

    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("doc")).toHaveTextContent("first");
    expect(screen.getByTestId("external")).toHaveTextContent("true");
  });

  it("reloadFromDisk discards local edits and clears the flag", async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("doc")).toHaveTextContent("first"));
    act(() => setTabDirty("pad-1", true));
    readFileMock.mockResolvedValue(contents("second"));
    await act(async () => {
      fileChangeListener?.({ path: ".pragma/scratchpads/pad.mdx", kind: "modified" });
    });

    await act(async () => {
      screen.getByRole("button", { name: "reload" }).click();
    });

    expect(screen.getByTestId("doc")).toHaveTextContent("second");
    expect(screen.getByTestId("external")).toHaveTextContent("false");
  });

  it("re-reads on window focus, so a missed watch event still resolves", async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("doc")).toHaveTextContent("first"));

    readFileMock.mockResolvedValue(contents("third"));
    await act(async () => {
      globalThis.dispatchEvent(new Event("focus"));
    });

    expect(screen.getByTestId("doc")).toHaveTextContent("third");
  });

  it("keeps the current document when a re-read fails mid-write", async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("doc")).toHaveTextContent("first"));

    readFileMock.mockRejectedValue(new Error("no such file"));
    await act(async () => {
      fileChangeListener?.({ path: ".pragma/scratchpads/pad.mdx", kind: "modified" });
    });

    expect(screen.getByTestId("kind")).toHaveTextContent("ready");
    expect(screen.getByTestId("doc")).toHaveTextContent("first");
  });

  it("restores a dirty document and its saved baseline after unmount", async () => {
    const first = render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("doc")).toHaveTextContent("first"));
    act(() => screen.getByRole("button", { name: "edit" }).click());
    expect(isTabDirty("pad-1")).toBe(true);
    first.unmount();

    render(<Probe />);
    expect(screen.getByTestId("doc")).toHaveTextContent("edited");
    expect(readFileMock).toHaveBeenCalledTimes(1);
    act(() => screen.getByRole("button", { name: "revert" }).click());
    expect(isTabDirty("pad-1")).toBe(false);
  });
});
