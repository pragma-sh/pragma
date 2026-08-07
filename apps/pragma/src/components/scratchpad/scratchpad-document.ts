/**
 * The managed scratchpad file contract.
 *
 * Frontmatter parsing, agent attachment, and the sibling comment-file path live
 * in `@pragma/scratchpad-viewer` because the mobile client edits the same files
 * over the gateway; this module only re-exports them so desktop code keeps
 * importing the contract from one place.
 */
export {
  attachScratchpadAgent,
  parseScratchpadDocument,
  replaceScratchpadBody,
  scratchpadCommentsPath,
  type ScratchpadDocument,
} from "@pragma/scratchpad-viewer";
