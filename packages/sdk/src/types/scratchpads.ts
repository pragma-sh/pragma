import type { ScratchpadFile } from "@pragma/constants";
import type { ScratchpadBlock, ScratchpadComment } from "@pragma/scratchpad-contract";

export type { ScratchpadFile };

/** Options for {@link ScratchpadsClient.getScratchpads}. */
export interface GetScratchpadsOptions {
  /** Absolute path of the worktree whose scratchpads should be listed. */
  root: string;
  signal?: AbortSignal;
}

/** One scratchpad, addressed the way every host RPC addresses a file. */
export interface ScratchpadRef {
  /** Absolute path of the worktree the scratchpad lives in. */
  root: string;
  /** Worktree-relative POSIX path of the scratchpad's MDX file. */
  filePath: string;
}

/** Options for {@link ScratchpadsClient.comment}. */
export interface CommentScratchpadOptions extends ScratchpadRef {
  /** The rendered block the comment is anchored to. */
  block: ScratchpadBlock;
  /** The comment body. Trimmed before it is stored. */
  text: string;
  /** Comment id. Generated when omitted. */
  id?: string;
  /** Creation timestamp in epoch milliseconds. Defaults to now. */
  createdAt?: number;
}

/** Options for {@link ScratchpadsClient.attachAgent}. */
export interface AttachScratchpadAgentOptions extends ScratchpadRef {
  /** Terminal tab id hosting the agent the scratchpad should prompt. */
  tabId: string;
  /** Catalog agent id of that tab (e.g. `pragma.claude-code`). */
  agentId: string;
  /** Current MDX source, when the caller already holds it, to skip a read. */
  contents?: string;
}

/** Options for {@link ScratchpadsClient.sendAttached}. */
export interface SendAttachedOptions extends ScratchpadRef {
  /** Worktree the attached tab belongs to. */
  worktreeId: string;
  /** Text delivered to the agent as an interjection. */
  text: string;
  /** Current MDX source, when the caller already holds it, to skip a read. */
  contents?: string;
  signal?: AbortSignal;
}

/**
 * Outcome of {@link ScratchpadsClient.sendAttached}: `delivered: false` means
 * the scratchpad names no agent, not that delivery failed.
 */
export type SendAttachedResult =
  | { delivered: false }
  | {
      delivered: true;
      /** Runtime agent id the interjection was addressed to. */
      agent: string;
      /** Tab the interjection was sent to. */
      tabId: string;
    };

export type { ScratchpadBlock, ScratchpadComment };
