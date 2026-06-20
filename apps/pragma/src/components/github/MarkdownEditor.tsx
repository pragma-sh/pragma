import { useEffect } from "react";

import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import { Markdown } from "tiptap-markdown";

const lowlight = createLowlight(common);

/** The `tiptap-markdown` storage slot, which has no bundled TS types. */
interface MarkdownStorage {
  markdown: { getMarkdown: () => string };
}

/** Reads the editor's current document as markdown via the `tiptap-markdown` storage. */
function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as MarkdownStorage).markdown.getMarkdown();
}

/**
 * A small rich-text editor whose **I/O is markdown**. TipTap renders a WYSIWYG
 * surface (bold, code, fenced blocks via lowlight, links), while the
 * `tiptap-markdown` extension serializes to/parses from markdown so the PR body
 * we send GitHub stays plain markdown. The plain `StarterKit` code block is
 * disabled in favor of the syntax-highlighted `CodeBlockLowlight`.
 *
 * Controlled by `value`/`onChange`: the editor seeds from `value` once on mount
 * and reports markdown on every edit. `value` is treated as the initial document
 * (re-seeded only when it changes while the editor is blurred), so typing is
 * never interrupted by the parent echoing state back.
 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder = "Describe your changes…",
  className,
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight }),
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder }),
      Markdown,
    ],
    content: value,
    editorProps: {
      attributes: {
        class:
          "tiptap prose prose-invert prose-sm max-w-none min-h-28 px-3 py-2 focus:outline-none",
      },
    },
    onUpdate: ({ editor: instance }) => {
      onChange(getMarkdown(instance));
    },
  });

  // Re-seed only when the incoming markdown diverges from what the editor holds
  // and the user isn't actively editing — e.g. the default title/body arrives
  // after the async fetch resolves. Comparing against the serialized markdown
  // avoids clobbering the user's cursor on every keystroke.
  useEffect(() => {
    if (!editor || editor.isFocused) {
      return;
    }
    if (getMarkdown(editor) !== value) {
      editor.commands.setContent(value);
    }
  }, [editor, value]);

  return (
    <div
      className={`rounded-md border border-white/15 bg-black/30 text-sm text-slate-100 focus-within:border-cyan-400/60 ${className ?? ""}`}
    >
      <EditorContent editor={editor} />
    </div>
  );
}
