import type { CodeViewerContent } from "@pragma-sh/code-viewer";

/** Props shared by the native and web code viewers. */
export interface CodeWebViewProps {
  /** The file or diff to show. Read-only: nothing here can change it. */
  content: CodeViewerContent;
  /** Soft-wrap long lines instead of scrolling sideways. */
  wrap: boolean;
  /** The document has painted. */
  onReady?: () => void;
}
