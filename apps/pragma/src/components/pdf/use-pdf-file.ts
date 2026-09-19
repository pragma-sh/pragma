import type { Tab } from "@pragma-sh/constants";

import { formatBytes, useBinaryFile, type BinaryFileState } from "@/lib/binary-file";

/** Lifecycle of the PDF bytes behind a viewer tab. */
export type PdfFileState = BinaryFileState;

export { formatBytes };

/**
 * Loads a tab's PDF bytes through the shared chunked binary reader. The viewer
 * is read-only, so unlike the editor there is no dirty state to protect.
 */
export function usePdfFile(tab: Tab): { state: PdfFileState; reload: () => void } {
  return useBinaryFile({
    worktreeId: tab.worktreeId,
    filePath: tab.filePath,
    label: "PDF",
  });
}
