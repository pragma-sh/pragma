import type { Editor } from "@tiptap/react";

/** The `tiptap-markdown` storage slot, which has no bundled TS types. */
interface MarkdownStorage {
  markdown: { getMarkdown: () => string };
}

/** Reads the editor's current document as markdown via the `tiptap-markdown` storage. */
export function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as MarkdownStorage).markdown.getMarkdown();
}
