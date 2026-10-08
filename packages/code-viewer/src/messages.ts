/**
 * The contract between a native client and the read-only code document.
 *
 * The content is fixed when the document is built — the viewer is read-only, so
 * there is nothing to stream in afterwards — which leaves only the renderer's
 * own reports crossing the bridge. They arrive as untrusted text and are
 * narrowed here; anything unrecognised is dropped.
 */

/** Id of the element carrying the embedded content. */
export const CODE_CONTENT_ELEMENT_ID = "pragma-code-content";

/** What the document shows: one file, or the changed lines between two versions. */
export type CodeViewerContent =
  | { kind: "file"; path: string; text: string }
  | { kind: "diff"; path: string; oldText: string; newText: string };

/** Sent by the renderer back to the host. */
export type CodeViewerMessage =
  /** The editor has painted; `lines` is the rendered document's line count. */
  | { type: "ready"; lines: number }
  /** The embedded content could not be read; the document shows nothing. */
  | { type: "error"; message: string };

/** Narrows an untrusted parsed value to content the runtime can render. */
export function isCodeViewerContent(value: unknown): value is CodeViewerContent {
  if (typeof value !== "object" || value === null) return false;
  const content = value as Record<string, unknown>;
  if (typeof content.path !== "string") return false;
  switch (content.kind) {
    case "file":
      return typeof content.text === "string";
    case "diff":
      return typeof content.oldText === "string" && typeof content.newText === "string";
    default:
      return false;
  }
}

/** Narrows an untrusted parsed value to a renderer message. */
export function isCodeViewerMessage(value: unknown): value is CodeViewerMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "ready":
      return typeof message.lines === "number";
    case "error":
      return typeof message.message === "string";
    default:
      return false;
  }
}

/** Parses a bridge payload into a message, or null when it is not one. */
export function parseCodeViewerMessage(raw: string): CodeViewerMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isCodeViewerMessage(value) ? value : null;
  } catch {
    return null;
  }
}
