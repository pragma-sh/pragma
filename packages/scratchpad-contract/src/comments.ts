import { isNumber, isString, matchesShape, nullable } from "./guards";
import type { ScratchpadBlock, ScratchpadComment } from "./types";

export type { ScratchpadComment };

/** Sibling JSON path storing one scratchpad's comment threads. */
export function scratchpadCommentsPath(filePath: string): string {
  return `${filePath}.comments.json`;
}

/**
 * Parses a persisted comment file, dropping malformed entries instead of
 * failing the whole document — one bad entry must not cost the user the rest of
 * their comments.
 */
export function parseScratchpadComments(source: string): ScratchpadComment[] {
  const value: unknown = JSON.parse(source);
  if (!Array.isArray(value)) throw new Error("Scratchpad comments must be an array.");
  return value.filter(isScratchpadComment);
}

/** Serializes comments in the exact on-disk shape the desktop writes. */
export function serializeScratchpadComments(comments: readonly ScratchpadComment[]): string {
  return `${JSON.stringify(comments, null, 2)}\n`;
}

/**
 * Builds one comment anchored to a rendered block.
 *
 * `from`/`to` stay `0`: they are ProseMirror positions in the desktop editor's
 * document, which a rendered web view has no way to compute. The desktop skips
 * decorating a zero-width range, so a phone-authored comment shows up in its
 * list and in the agent handoff without highlighting an arbitrary paragraph.
 */
export function createScratchpadComment(
  block: ScratchpadBlock,
  text: string,
  now: number,
  id: string,
): ScratchpadComment {
  return {
    id,
    from: 0,
    to: 0,
    quote: block.quote,
    text: text.trim(),
    createdAt: now,
    resolvedAt: null,
    blockIndex: block.index,
  };
}

/** Comments still awaiting the agent. */
export function unresolvedComments(
  comments: readonly ScratchpadComment[],
): readonly ScratchpadComment[] {
  return comments.filter((comment) => comment.resolvedAt === null);
}

/** Stamps every open comment as resolved at the given time. */
export function markAllResolved(
  comments: readonly ScratchpadComment[],
  now: number,
): ScratchpadComment[] {
  return comments.map((comment) =>
    comment.resolvedAt === null ? { ...comment, resolvedAt: now } : comment,
  );
}

/**
 * The handoff message an agent receives when the user submits open comments.
 * Shared with the desktop so an agent sees the same prompt either way.
 */
export function unresolvedCommentsPrompt(unresolved: readonly ScratchpadComment[]): string {
  return [
    "The user left the following scratchpad comments for you to address:",
    ...unresolved.map((comment, index) => `${index + 1}. On "${comment.quote}": ${comment.text}`),
  ].join("\n");
}

function isScratchpadComment(value: unknown): value is ScratchpadComment {
  return matchesShape(value, {
    id: isString,
    from: isNumber,
    to: isNumber,
    quote: isString,
    text: isString,
    createdAt: isNumber,
    resolvedAt: nullable(isNumber),
  });
}
