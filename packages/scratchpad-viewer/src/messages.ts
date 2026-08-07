/**
 * The two-way contract between a native client and the scratchpad viewer
 * document it hosts in a web view. Both sides import these types, so a change
 * to one end fails to typecheck at the other.
 */

/** One block of the rendered document a comment can be attached to. */
export interface ScratchpadBlock {
  /** Index of the block among the document's top-level rendered blocks. */
  index: number;
  /** Plain-text excerpt of the block, used as the comment's quote. */
  quote: string;
}

/** Messages the viewer document posts to its native host. */
export type ScratchpadViewerMessage =
  /** The document rendered; height is its full scroll height in CSS pixels. */
  | { type: "ready"; height: number }
  /** The document's height changed (a component expanded, fonts loaded). */
  | { type: "height"; height: number }
  /** MDX failed to compile or a component threw while rendering. */
  | { type: "error"; message: string }
  /** A long press is hovering a block: where the comment would land. */
  | { type: "preview"; block: ScratchpadBlock | null }
  /** A tap, or the release of a long press, chose a block to comment on. */
  | { type: "select"; block: ScratchpadBlock }
  /** A rendered component asked to prompt the attached agent. */
  | { type: "promptAgent"; requestId: string; text: string }
  /** A rendered component asked the host to attach an agent tab. */
  | { type: "requestAgentAttachment"; requestId: string }
  /** A rendered component subscribed to attached-agent progress. */
  | { type: "subscribeAgentProgress"; requestId: string; tabIds: string[] }
  /** The component's progress subscription was torn down. */
  | { type: "unsubscribeAgentProgress"; requestId: string };

/** One persisted scratchpad comment, in the desktop's on-disk shape. */
export interface ScratchpadComment {
  id: string;
  /**
   * ProseMirror document positions the desktop editor decorates. A native
   * client has no ProseMirror document, so it writes `0`/`0` and anchors by
   * {@link ScratchpadComment.quote} and {@link ScratchpadComment.blockIndex}
   * instead; the desktop then renders the comment without a highlight rather
   * than highlighting the wrong range.
   */
  from: number;
  to: number;
  quote: string;
  text: string;
  createdAt: number;
  resolvedAt: number | null;
  /** Rendered block this comment was attached to, when written on mobile. */
  blockIndex?: number;
}

/** Commands the native host sends into the viewer document. */
export type ScratchpadViewerCommand =
  /** Replaces the highlighted comment set. */
  | { type: "comments"; comments: ScratchpadComment[] }
  /** Turns the tap/long-press comment picker on or off. */
  | { type: "commentMode"; active: boolean }
  /** Clears the current selection highlight without leaving comment mode. */
  | { type: "clearSelection" }
  /** Re-themes the document in place (host theme changed). */
  | { type: "theme"; css: string; mode: "light" | "dark" }
  /** Resolves a pending {@link ScratchpadViewerMessage} request. */
  | { type: "response"; requestId: string; value?: unknown; error?: string }
  /** Delivers an agent-progress update to a subscribed component. */
  | { type: "progress"; requestId: string; entries: unknown[] };
