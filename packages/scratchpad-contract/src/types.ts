/**
 * The on-disk shapes every scratchpad client shares.
 *
 * They live in their own module (and their own package) because the desktop
 * editor, the SDK, the read-only viewer, and the native clients all read and
 * write the same two files — the MDX with its managed frontmatter, and the
 * sibling comment thread — and a second definition of either shape is how they
 * drift apart.
 */

/** One block of the rendered document a comment can be attached to. */
export interface ScratchpadBlock {
  /** Index of the block among the document's top-level rendered blocks. */
  index: number;
  /** Plain-text excerpt of the block, used as the comment's quote. */
  quote: string;
}

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
