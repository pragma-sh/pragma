import type { CodeViewerContent } from "@pragma-sh/code-viewer";
import type { FileContents, FileDiff } from "@pragma-sh/constants";

// Pure mapping from host reads to what the read-only code screens show: either
// content for the viewer, or the reason there is none. Kept apart from the
// screens so the decisions are tested without rendering.

/** Why a file cannot be shown as text, when it cannot. */
export type CodeUnavailable = { kind: "binary" } | { kind: "tooLarge"; bytes: number };

/** What a code screen renders once its read has landed. */
export interface CodeView {
  content: CodeViewerContent | null;
  unavailable: CodeUnavailable | null;
}

const NOTHING: CodeView = { content: null, unavailable: null };

/** A file read → viewer content, or binary/too-large. */
export function fileView(file: FileContents | undefined, path: string): CodeView {
  if (!file) return NOTHING;
  if (file.binary) return { content: null, unavailable: { kind: "binary" } };
  if (file.truncated) {
    return { content: null, unavailable: { kind: "tooLarge", bytes: file.byteSize } };
  }
  return { content: { kind: "file", path, text: file.text }, unavailable: null };
}

/** A base-commit diff → viewer content, or binary. */
export function diffView(diff: FileDiff | undefined, path: string): CodeView {
  if (!diff) return NOTHING;
  if (diff.binary) return { content: null, unavailable: { kind: "binary" } };
  return {
    content: { kind: "diff", path, oldText: diff.oldText, newText: diff.newText },
    unavailable: null,
  };
}

/** The sentence shown in place of a file that cannot be rendered. */
export function unavailableText(unavailable: CodeUnavailable): string {
  if (unavailable.kind === "binary") return "This is a binary file, so there is no text to show.";
  const megabytes = (unavailable.bytes / (1024 * 1024)).toFixed(1);
  return `This file is ${megabytes} MB, larger than the host will send. Open it on your computer.`;
}

/** The last segment of a worktree-relative path. */
export function fileName(path: string): string {
  return path.split("/").pop() || path;
}
