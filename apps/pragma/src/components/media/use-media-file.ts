import { useEffect, useState } from "react";

import type { Tab } from "@pragma/constants";

import { mediaKind, mediaMimeType, type MediaKind } from "@/components/media/media-path";
import { formatBytes, useBinaryFile, type BinaryFileState } from "@/lib/binary-file";

export { formatBytes };

/** Lifecycle of a media blob URL behind a viewer tab. */
export type MediaFileState =
  | { kind: "loading"; loadedBytes: number; totalBytes: number }
  | { kind: "ready"; url: string; mediaKind: MediaKind }
  | { kind: "error"; message: string };

/** Noun for size-limit errors, keyed by the media surface. */
function labelFor(kind: MediaKind | null): string {
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  if (kind === "audio") return "audio file";
  return "file";
}

/**
 * Loads a tab's media bytes through the shared chunked reader and exposes a
 * blob URL the `<img>` / `<video>` element can play. The URL is revoked whenever
 * the bytes change or the tab unmounts.
 */
export function useMediaFile(tab: Tab): { state: MediaFileState; reload: () => void } {
  const kind = mediaKind(tab.filePath);
  const binary = useBinaryFile({
    worktreeId: tab.worktreeId,
    filePath: tab.filePath,
    label: labelFor(kind),
  });
  const [blobState, setBlobState] = useState<MediaFileState>(() =>
    fromBinary(binary.state, null, kind),
  );

  useEffect(() => {
    if (binary.state.kind !== "ready" || !tab.filePath || kind === null) {
      setBlobState(fromBinary(binary.state, null, kind));
      return;
    }
    const blob = new Blob([new Uint8Array(binary.state.buffer)], {
      type: mediaMimeType(tab.filePath),
    });
    const url = URL.createObjectURL(blob);
    setBlobState({ kind: "ready", url, mediaKind: kind });
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [binary.state, tab.filePath, kind]);

  return { state: blobState, reload: binary.reload };
}

/** Maps a binary load state onto the media state's non-ready shapes. */
function fromBinary(
  state: BinaryFileState,
  url: string | null,
  kind: MediaKind | null,
): MediaFileState {
  if (state.kind === "loading") return state;
  if (state.kind === "error") return state;
  if (url && kind) return { kind: "ready", url, mediaKind: kind };
  return {
    kind: "loading",
    loadedBytes: state.buffer.byteLength,
    totalBytes: state.buffer.byteLength,
  };
}
