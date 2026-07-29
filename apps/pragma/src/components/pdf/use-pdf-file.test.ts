import type { FileChange, FileChunk, Tab } from "@pragma/constants";
import { constants } from "@pragma/constants";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileChunkMock = vi.fn();
vi.mock("@/lib/tauri", () => ({
  readFileChunk: (...args: unknown[]) => readFileChunkMock(...args),
}));

let fileChangeListener: ((change: FileChange) => void) | null = null;
vi.mock("@/lib/file-watch", () => ({
  useWorktreeFileChange: (_worktreeId: string, onChange: (change: FileChange) => void) => {
    fileChangeListener = onChange;
  },
}));

const { usePdfFile } = await import("@/components/pdf/use-pdf-file");

/**
 * A tab on its own file. Read bytes are cached per worktree+path across mounts,
 * so tests must not share a path unless they are exercising that cache.
 */
function tabFor(name: string): Tab {
  return { id: `tab-${name}`, worktreeId: "wt-1", filePath: `docs/${name}.pdf` } as Tab;
}

/** Encodes raw bytes the way the host's chunked read does. */
function encode(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Serves `bytes` in fixed-size slices, as a host walking the file would. */
function serveInSlices(bytes: number[], sliceSize: number) {
  return (_worktreeId: string, _path: string, offset: number): Promise<FileChunk> => {
    const slice = bytes.slice(offset, offset + sliceSize);
    return Promise.resolve({
      base64: encode(slice),
      offset,
      byteSize: bytes.length,
      eof: offset + slice.length >= bytes.length,
    });
  };
}

describe("usePdfFile", () => {
  beforeEach(() => {
    readFileChunkMock.mockReset();
    fileChangeListener = null;
  });

  it("assembles a file that spans several chunks in order", async () => {
    const bytes = [37, 80, 68, 70, 45, 49, 46, 55, 10, 37];
    readFileChunkMock.mockImplementation(serveInSlices(bytes, 4));

    const { result } = renderHook(() => usePdfFile(tabFor("chunked")));

    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    if (result.current.state.kind !== "ready") throw new Error("expected ready");
    expect([...new Uint8Array(result.current.state.buffer)]).toEqual(bytes);
    // 10 bytes in 4-byte slices: three reads, the last one flagged eof.
    expect(readFileChunkMock).toHaveBeenCalledTimes(3);
    expect(readFileChunkMock.mock.calls.map((call) => call[2])).toEqual([0, 4, 8]);
  });

  it("refuses a file past the in-memory preview limit without reading it", async () => {
    readFileChunkMock.mockResolvedValue({
      base64: "",
      offset: 0,
      byteSize: constants.files.maxBinaryBytes + 1,
      eof: false,
    } satisfies FileChunk);

    const { result } = renderHook(() => usePdfFile(tabFor("oversize")));

    await waitFor(() => expect(result.current.state.kind).toBe("error"));
    if (result.current.state.kind !== "error") throw new Error("expected error");
    expect(result.current.state.message).toMatch(/larger than/);
    expect(readFileChunkMock).toHaveBeenCalledTimes(1);
  });

  it("re-reads when the open file changes on disk", async () => {
    readFileChunkMock.mockImplementation(serveInSlices([1, 2, 3], 8));
    const { result } = renderHook(() => usePdfFile(tabFor("watched")));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));

    readFileChunkMock.mockImplementation(serveInSlices([9, 9], 8));
    fileChangeListener?.({ path: "docs/watched.pdf", kind: "modified" } as FileChange);

    await waitFor(() => {
      const { state } = result.current;
      if (state.kind !== "ready") throw new Error("expected ready");
      expect([...new Uint8Array(state.buffer)]).toEqual([9, 9]);
    });
  });

  it("serves a remounted tab from cache instead of re-reading the file", async () => {
    readFileChunkMock.mockImplementation(serveInSlices([1, 2, 3], 8));
    const first = renderHook(() => usePdfFile(tabFor("remount")));
    await waitFor(() => expect(first.result.current.state.kind).toBe("ready"));
    first.unmount();
    readFileChunkMock.mockClear();

    const second = renderHook(() => usePdfFile(tabFor("remount")));

    await waitFor(() => expect(second.result.current.state.kind).toBe("ready"));
    expect(readFileChunkMock).not.toHaveBeenCalled();
    if (second.result.current.state.kind !== "ready") throw new Error("expected ready");
    expect([...new Uint8Array(second.result.current.state.buffer)]).toEqual([1, 2, 3]);
  });

  it("hands every mount its own buffer, so a detached one cannot poison the cache", async () => {
    readFileChunkMock.mockImplementation(serveInSlices([7, 7], 8));
    const first = renderHook(() => usePdfFile(tabFor("detach")));
    await waitFor(() => expect(first.result.current.state.kind).toBe("ready"));
    const firstState = first.result.current.state;
    if (firstState.kind !== "ready") throw new Error("expected ready");

    const second = renderHook(() => usePdfFile(tabFor("detach")));
    await waitFor(() => expect(second.result.current.state.kind).toBe("ready"));
    const secondState = second.result.current.state;
    if (secondState.kind !== "ready") throw new Error("expected ready");

    expect(secondState.buffer).not.toBe(firstState.buffer);
    expect([...new Uint8Array(secondState.buffer)]).toEqual([7, 7]);
  });

  it("ignores changes to other files in the worktree", async () => {
    readFileChunkMock.mockImplementation(serveInSlices([1], 8));
    const { result } = renderHook(() => usePdfFile(tabFor("unrelated")));
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    readFileChunkMock.mockClear();

    fileChangeListener?.({ path: "docs/other.pdf", kind: "modified" } as FileChange);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readFileChunkMock).not.toHaveBeenCalled();
  });
});
