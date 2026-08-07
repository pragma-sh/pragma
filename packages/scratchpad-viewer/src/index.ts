export {
  buildScratchpadViewerHtml,
  scratchpadThemeCss,
  type ScratchpadViewerHtmlOptions,
} from "./html";
export { prepareMdxSource } from "./mdx-source";
// The file contract itself lives in `@pragma/scratchpad-contract` (the SDK
// depends on it too, and cannot depend on this renderer). Re-exported so a host
// that already imports the viewer needs only one import for both halves.
export {
  attachScratchpadAgent,
  createScratchpadComment,
  markAllResolved,
  parseScratchpadComments,
  parseScratchpadDocument,
  replaceScratchpadBody,
  scratchpadCommentsPath,
  serializeScratchpadComments,
  unresolvedComments,
  unresolvedCommentsPrompt,
  type ScratchpadDocument,
  type ScratchpadMetadata,
} from "@pragma/scratchpad-contract";
export type {
  ScratchpadBlock,
  ScratchpadComment,
  ScratchpadViewerCommand,
  ScratchpadViewerMessage,
} from "./messages";
