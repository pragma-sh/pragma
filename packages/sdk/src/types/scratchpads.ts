import type { ScratchpadFile } from "@pragma/constants";

export type { ScratchpadFile };

/** Options for {@link ScratchpadsClient.getScratchpads}. */
export interface GetScratchpadsOptions {
  /** Absolute path of the worktree whose scratchpads should be listed. */
  root: string;
  signal?: AbortSignal;
}
