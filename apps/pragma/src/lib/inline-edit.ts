import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";

import type { AiInlineEditReplacement } from "@/lib/tauri";

/**
 * Inline AI edits: turning the model's exact-text replacements into a document
 * the editor can show as a red/green diff, and into the changes that accept or
 * reject one of its hunks.
 *
 * All of it is pure string/offset math so it can be unit-tested without an
 * editor; the CodeMirror wiring lives in `components/editor/inline-edit.tsx`.
 */

/** A replacement that could not be anchored in the buffer, and why. */
export interface SkippedInlineEdit {
  edit: AiInlineEditReplacement;
  /** `missing` when the anchor was not found, `ambiguous` when it matched twice. */
  reason: "missing" | "ambiguous";
}

/** Result of applying a draft's replacements to the buffer. */
export interface AppliedInlineEdits {
  /** The buffer with every anchored replacement applied. */
  doc: string;
  /** How many replacements were applied. */
  applied: number;
  /** Replacements that were dropped because their anchor did not resolve. */
  skipped: SkippedInlineEdit[];
}

/**
 * Apply exact-text replacements to `doc`, in order.
 *
 * A replacement is only applied when its `oldText` matches exactly once in the
 * document as it stands at that point; anything else is skipped rather than
 * guessed at, because a wrong anchor silently corrupts the user's file.
 */
export function applyInlineEdits(
  doc: string,
  edits: readonly AiInlineEditReplacement[],
): AppliedInlineEdits {
  let next = doc;
  let applied = 0;
  const skipped: SkippedInlineEdit[] = [];

  for (const edit of edits) {
    const first = next.indexOf(edit.oldText);
    if (first < 0) {
      skipped.push({ edit, reason: "missing" });
      continue;
    }
    if (next.indexOf(edit.oldText, first + 1) >= 0) {
      skipped.push({ edit, reason: "ambiguous" });
      continue;
    }
    next = next.slice(0, first) + edit.newText + next.slice(first + edit.oldText.length);
    applied += 1;
  }

  return { doc: next, applied, skipped };
}

/** One reviewable block of the preview document: the old lines and the new ones. */
export interface InlineEditHunk {
  /** Stable identity for the lifetime of one review, in document order. */
  id: number;
  /** Range of the removed (red) lines in the preview document. */
  deleted: { from: number; to: number };
  /** Range of the added (green) lines in the preview document. */
  added: { from: number; to: number };
}

/** A document showing both sides of every change, plus its reviewable hunks. */
export interface InlineEditPreview {
  /** Base lines, with each change rendered as its old lines then its new lines. */
  doc: string;
  hunks: InlineEditHunk[];
}

/** Half-open line range `[from, to)` in a line array. */
interface LineRange {
  from: number;
  to: number;
}

/** The 1-based line range a chunk covers on one side, as a half-open pair. */
function chunkLines(text: Text, from: number, to: number): LineRange {
  if (from === to) {
    const line = text.lineAt(Math.min(from, text.length)).number;
    return { from: line - 1, to: line - 1 };
  }
  return {
    from: text.lineAt(from).number - 1,
    to: text.lineAt(Math.min(to - 1, text.length)).number,
  };
}

/** Character offset of the first character of `line` in `lines.join("\n")`. */
function offsetOfLine(lines: readonly string[], line: number): number {
  let offset = 0;
  for (let index = 0; index < line; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset;
}

/**
 * Character range covering whole lines `[from, to)` **including** the newline
 * that terminates each, so deleting the range leaves the surrounding lines
 * intact. A range that runs to the end of the document takes the preceding
 * newline instead, since there is no trailing one to take.
 */
function lineRangeOffsets(
  lines: readonly string[],
  range: LineRange,
): { from: number; to: number } {
  if (range.from === range.to) {
    const at = offsetOfLine(lines, range.from);
    return { from: at, to: at };
  }
  const docLength = offsetOfLine(lines, lines.length) - 1;
  const from = offsetOfLine(lines, range.from);
  const to = offsetOfLine(lines, range.to);
  if (to > docLength) {
    return { from: Math.max(0, from - 1), to: docLength };
  }
  return { from, to };
}

/**
 * Build the review document for a proposed rewrite: every unchanged line of
 * `base`, and at each change the removed lines immediately followed by the
 * added ones — the same shape Cursor shows, so accepting a hunk is "drop the red
 * lines" and rejecting it is "drop the green lines".
 *
 * Returns no hunks when the two documents are identical.
 */
export function buildInlineEditPreview(base: string, proposed: string): InlineEditPreview {
  const baseLines = base.split("\n");
  const proposedLines = proposed.split("\n");
  const baseText = Text.of(baseLines);
  const proposedText = Text.of(proposedLines);
  const chunks = base === proposed ? [] : Chunk.build(baseText, proposedText);

  const previewLines: string[] = [];
  const spans: Array<{ deleted: LineRange; added: LineRange }> = [];
  let copiedTo = 0;

  for (const chunk of chunks) {
    const inBase = chunkLines(baseText, chunk.fromA, chunk.toA);
    const inProposed = chunkLines(proposedText, chunk.fromB, chunk.toB);

    previewLines.push(...baseLines.slice(copiedTo, inBase.from));
    const deletedFrom = previewLines.length;
    previewLines.push(...baseLines.slice(inBase.from, inBase.to));
    const addedFrom = previewLines.length;
    previewLines.push(...proposedLines.slice(inProposed.from, inProposed.to));

    spans.push({
      deleted: { from: deletedFrom, to: addedFrom },
      added: { from: addedFrom, to: previewLines.length },
    });
    copiedTo = inBase.to;
  }
  previewLines.push(...baseLines.slice(copiedTo));

  return {
    doc: previewLines.join("\n"),
    hunks: spans.map((span, index) => ({
      id: index,
      deleted: lineRangeOffsets(previewLines, span.deleted),
      added: lineRangeOffsets(previewLines, span.added),
    })),
  };
}

/**
 * The document change that resolves one hunk: accepting drops its red lines,
 * rejecting drops its green ones. An empty side yields an empty change, which
 * is a no-op the caller can dispatch unconditionally.
 */
export function resolveHunkChange(
  hunk: InlineEditHunk,
  decision: "accept" | "reject",
): { from: number; to: number } {
  return decision === "accept" ? hunk.deleted : hunk.added;
}
