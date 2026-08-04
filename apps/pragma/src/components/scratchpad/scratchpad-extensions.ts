import type { AnyExtension } from "@tiptap/core";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { StarterKit } from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import { Markdown } from "tiptap-markdown";

const lowlight = createLowlight(common);

/**
 * Base markdown-editing extensions shared by the scratchpad document editor and
 * the nested editor used for markdown inside MDX component blocks.
 */
export function scratchpadMarkdownExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({ codeBlock: false, link: { openOnClick: false } }),
    CodeBlockLowlight.configure({ lowlight }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown.configure({ html: true, linkify: true }),
  ];
}
