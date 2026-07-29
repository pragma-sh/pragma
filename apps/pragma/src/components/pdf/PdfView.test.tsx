import type { FileChange, FileChunk, Tab } from "@pragma/constants";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileChunkMock = vi.fn();
vi.mock("@/lib/tauri", () => ({
  readFileChunk: (...args: unknown[]) => readFileChunkMock(...args),
}));
vi.mock("@/lib/file-watch", () => ({
  useWorktreeFileChange: (_worktreeId: string, _onChange: (change: FileChange) => void) => {},
}));

// The real engine is a pdfium WebAssembly module in a worker — it cannot paint
// under jsdom, so the surface below stands in for the rendered document.
const engineStateMock = vi.fn();
vi.mock("@/components/pdf/pdf-engine", () => ({
  usePdfEngine: () => engineStateMock(),
}));
vi.mock("@/components/pdf/PdfDocument", () => ({
  PdfDocument: ({ buffer, name }: { buffer: ArrayBuffer; name: string }) => (
    <div aria-label="pdf-document" data-bytes={buffer.byteLength} data-name={name} />
  ),
}));

const { PdfView } = await import("@/components/pdf/PdfView");

/**
 * A tab on its own file. `usePdfFile` caches read bytes per worktree+path
 * across mounts, so a shared path would let one test serve the next.
 */
function tabFor(name: string): Tab {
  return { id: `tab-${name}`, worktreeId: "wt-1", filePath: `docs/${name}.pdf` } as Tab;
}

/** One complete chunk holding `bytes`. */
function wholeFile(bytes: number[]): FileChunk {
  return {
    base64: btoa(String.fromCharCode(...bytes)),
    offset: 0,
    byteSize: bytes.length,
    eof: true,
  };
}

describe("PdfView", () => {
  beforeEach(() => {
    readFileChunkMock.mockReset();
    engineStateMock.mockReturnValue({ kind: "ready", engine: {} });
  });
  afterEach(cleanup);

  it("renders the document once the bytes and the engine are both ready", async () => {
    readFileChunkMock.mockResolvedValue(wholeFile([37, 80, 68, 70]));

    render(<PdfView tab={tabFor("spec")} />);

    const surface = await screen.findByLabelText("pdf-document");
    expect(surface.dataset.bytes).toBe("4");
    expect(surface.dataset.name).toBe("spec.pdf");
  });

  it("waits on the engine after the file has loaded", async () => {
    readFileChunkMock.mockResolvedValue(wholeFile([37]));
    engineStateMock.mockReturnValue({ kind: "loading" });

    render(<PdfView tab={tabFor("waiting")} />);

    expect(await screen.findByText(/Starting the PDF engine/)).toBeInTheDocument();
    expect(screen.queryByLabelText("pdf-document")).toBeNull();
  });

  it("surfaces a read failure with a retry that reads again", async () => {
    readFileChunkMock.mockRejectedValueOnce(new Error("permission denied"));

    render(<PdfView tab={tabFor("retried")} />);

    expect(await screen.findByText("permission denied")).toBeInTheDocument();
    readFileChunkMock.mockResolvedValue(wholeFile([37]));
    screen.getByRole("button", { name: "Retry" }).click();

    await waitFor(() => expect(screen.getByLabelText("pdf-document")).toBeInTheDocument());
  });

  it("reports an engine that failed to start", async () => {
    readFileChunkMock.mockResolvedValue(wholeFile([37]));
    engineStateMock.mockReturnValue({ kind: "error", message: "wasm blocked" });

    render(<PdfView tab={tabFor("engine-error")} />);

    expect(await screen.findByText(/wasm blocked/)).toBeInTheDocument();
  });
});
