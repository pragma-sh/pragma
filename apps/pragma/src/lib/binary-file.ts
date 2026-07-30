import { useCallback, useEffect, useState } from "react";

import { constants } from "@pragma/constants";

import { decodeBase64 } from "@/lib/base64";
import { errorMessage } from "@/lib/errors";
import { useWorktreeFileChange } from "@/lib/file-watch";
import { readFileChunk } from "@/lib/tauri";

/** Lifecycle of bytes loaded through the chunked binary read path. */
export type BinaryFileState =
  | { kind: "loading"; loadedBytes: number; totalBytes: number }
  | { kind: "ready"; buffer: ArrayBuffer }
  | { kind: "error"; message: string };

const { chunkBytes, maxBinaryBytes } = constants.files;

/**
 * Reads a whole binary file into memory one chunk at a time. Chunking is what
 * makes binary previews work at all: `readFile` refuses non-UTF-8 content and a
 * single-frame byte read is capped well below an ordinary media file, so the
 * file is walked with `readFileChunk` until the host reports `eof`.
 */
async function readWholeFile(
  worktreeId: string,
  filePath: string,
  label: string,
  onProgress: (loadedBytes: number, totalBytes: number) => void,
  isCancelled: () => boolean,
): Promise<ArrayBuffer> {
  const first = await readFileChunk(worktreeId, filePath, 0, chunkBytes);
  if (first.byteSize > maxBinaryBytes) {
    throw new Error(
      `This ${label} is ${formatBytes(first.byteSize)}, larger than the ${formatBytes(maxBinaryBytes)} preview limit.`,
    );
  }
  const bytes = new Uint8Array(first.byteSize);
  let chunk = first;
  let offset = 0;
  while (!isCancelled()) {
    const decoded = decodeBase64(chunk.base64);
    bytes.set(decoded, offset);
    offset += decoded.length;
    onProgress(offset, first.byteSize);
    // `eof` is the host's word for "nothing follows"; an empty chunk without it
    // would otherwise loop forever on a file that shrank mid-read.
    if (chunk.eof || decoded.length === 0) break;
    // oxlint-disable-next-line eslint/no-await-in-loop -- chunks must be read sequentially; each offset depends on the previous.
    chunk = await readFileChunk(worktreeId, filePath, offset, chunkBytes);
  }
  return bytes.buffer as ArrayBuffer;
}

/** Human-readable byte size for the size-limit and progress messages. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * The few most recently read binary files, so switching back to a tab does not
 * re-read the whole file over IPC — a pane renders only its active tab, so every
 * switch away unmounts the viewer. Bounded because these are whole files in the
 * webview's heap; the oldest entry is dropped when a new one arrives.
 */
const CACHED_FILES = 5;
const bufferCache = new Map<string, ArrayBuffer>();

/** Cache key for one worktree-relative file. */
function cacheKey(worktreeId: string, filePath: string): string {
  return `${worktreeId}\0${filePath}`;
}

/**
 * Reads a file, serving a cached copy when one is held. Callers always get their
 * own `ArrayBuffer` so a consumer that transfers or detaches its copy cannot
 * poison later opens.
 */
async function readCachedFile(
  worktreeId: string,
  filePath: string,
  label: string,
  onProgress: (loadedBytes: number, totalBytes: number) => void,
  isCancelled: () => boolean,
): Promise<ArrayBuffer> {
  const key = cacheKey(worktreeId, filePath);
  const cached = bufferCache.get(key);
  if (cached && cached.byteLength > 0) {
    // Refresh recency: Map iterates in insertion order, so re-inserting moves
    // this entry to the end and keeps the eviction below on the oldest.
    bufferCache.delete(key);
    bufferCache.set(key, cached);
    return cached.slice(0);
  }
  const buffer = await readWholeFile(worktreeId, filePath, label, onProgress, isCancelled);
  if (isCancelled()) return buffer;
  bufferCache.set(key, buffer);
  while (bufferCache.size > CACHED_FILES) {
    const oldest = bufferCache.keys().next();
    if (oldest.done) break;
    bufferCache.delete(oldest.value);
  }
  return buffer.slice(0);
}

/** Options for {@link useBinaryFile}. */
export type UseBinaryFileOptions = {
  worktreeId: string;
  filePath: string | null;
  /** Noun used in size-limit errors (e.g. "PDF", "image"). */
  label: string;
};

/**
 * Loads worktree-relative binary bytes, reloading when the file changes on disk.
 * Viewers are read-only, so unlike the editor there is no dirty state to protect
 * and a change is always safe to pick up.
 */
export function useBinaryFile({ worktreeId, filePath, label }: UseBinaryFileOptions): {
  state: BinaryFileState;
  reload: () => void;
} {
  const [state, setState] = useState<BinaryFileState>({
    kind: "loading",
    loadedBytes: 0,
    totalBytes: 0,
  });
  const [generation, setGeneration] = useState(0);
  // A reload always means "the cached bytes are wrong or unwanted" — a retry
  // after a failure, or the file changing underneath us.
  const reload = useCallback(() => {
    if (filePath) bufferCache.delete(cacheKey(worktreeId, filePath));
    setGeneration((previous) => previous + 1);
  }, [worktreeId, filePath]);

  useEffect(() => {
    if (!filePath) {
      setState({ kind: "error", message: "This tab has no file path." });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading", loadedBytes: 0, totalBytes: 0 });
    void (async () => {
      try {
        const buffer = await readCachedFile(
          worktreeId,
          filePath,
          label,
          (loadedBytes, totalBytes) => {
            if (!cancelled) setState({ kind: "loading", loadedBytes, totalBytes });
          },
          () => cancelled,
        );
        if (!cancelled) setState({ kind: "ready", buffer });
      } catch (cause) {
        if (!cancelled) setState({ kind: "error", message: errorMessage(cause) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [worktreeId, filePath, generation, label]);

  useWorktreeFileChange(worktreeId, (change) => {
    if (change.path === filePath) reload();
  });

  return { state, reload };
}
