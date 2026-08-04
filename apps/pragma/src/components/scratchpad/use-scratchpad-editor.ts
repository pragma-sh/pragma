import { useEffect, useRef } from "react";

import type { EditorView } from "@tiptap/pm/view";
import { type Editor, useEditor } from "@tiptap/react";

import {
  inlineEditRequestFor,
  type MarkdownInlineEditRequest,
} from "@/components/editor/MarkdownView";
import { getMarkdown } from "@/components/editor/tiptap-markdown";
import {
  MdxJsxContainer,
  MdxRenderedBlock,
  preprocessMdxForTiptap,
} from "@/components/scratchpad/mdx-hybrid";
import {
  scratchpadCommentDecorations,
  ScratchpadCommentPickerExtension,
  ScratchpadCommentsExtension,
  type ScratchpadComment,
  type ScratchpadRange,
  setScratchpadCommentDecorations,
} from "@/components/scratchpad/scratchpad-comments";
import { scratchpadMarkdownExtensions } from "@/components/scratchpad/scratchpad-extensions";
import { errorMessage } from "@/lib/errors";

const EDITOR_CLASS =
  "tiptap prose prose-invert prose-sm max-w-3xl min-h-full px-6 py-4 focus:outline-none";

export interface ScratchpadEditorOptions {
  body: string;
  comments: readonly ScratchpadComment[];
  filePath: string;
  worktreeId: string;
  getAttachedAgentTabId: () => string | null;
  onBodyChange: (body: string) => void;
  onCommentsChange: (comments: ScratchpadComment[]) => void;
  onInlineEdit: (request: MarkdownInlineEditRequest) => void;
  onRequestAgentAttachment: () => Promise<boolean>;
  onSave: () => void;
}

export interface ScratchpadEditorHandlers {
  onHover: (range: ScratchpadRange | null) => void;
  onPick: (range: ScratchpadRange | null) => void;
}

export interface ScratchpadEditor {
  editor: Editor | null;
  /** Set when the body is not valid MDX; the surface then points the user at Raw mode. */
  parseError: string | null;
}

/**
 * Builds the scratchpad's TipTap editor and keeps it in sync with the document:
 * comment decorations in, markdown out, and external body rewrites pushed back in.
 */
export function useScratchpadEditor(
  options: ScratchpadEditorOptions,
  handlers: ScratchpadEditorHandlers,
): ScratchpadEditor {
  const { body, comments, filePath, worktreeId, getAttachedAgentTabId } = options;
  const appliedBodyRef = useRef(body);
  const callbacksRef = useRef(options);
  callbacksRef.current = options;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  let prepared = "";
  let parseError: string | null = null;
  try {
    prepared = preprocessMdxForTiptap(body);
  } catch (cause) {
    parseError = errorMessage(cause);
  }

  const editor = useEditor({
    extensions: [
      ...scratchpadMarkdownExtensions(),
      MdxJsxContainer,
      MdxRenderedBlock.configure({
        filePath,
        getAttachedAgentTabId,
        onRequestAgentAttachment: options.onRequestAgentAttachment,
        worktreeId,
      }),
      ScratchpadCommentsExtension,
      ScratchpadCommentPickerExtension.configure({
        onHover: (range) => handlersRef.current.onHover(range),
        onPick: (range) => handlersRef.current.onPick(range),
      }),
    ],
    content: prepared,
    editorProps: {
      attributes: { class: EDITOR_CLASS },
      handleKeyDown: (view, event) => handleEditorKeyDown(view, event, callbacksRef.current),
    },
    onUpdate: ({ editor: instance }) => {
      const next = getMarkdown(instance);
      appliedBodyRef.current = next;
      callbacksRef.current.onBodyChange(next);
    },
    onTransaction: ({ editor: instance, transaction }) => {
      if (transaction.docChanged) {
        callbacksRef.current.onCommentsChange(scratchpadCommentDecorations(instance));
      }
    },
  });

  useEffect(() => {
    if (editor) setScratchpadCommentDecorations(editor, comments);
  }, [editor, comments]);

  // Push a new body into the editor whenever it comes from outside this editor
  // — an agent rewriting the file, a reload from disk, a Raw-mode edit. Keyed on
  // the body we last applied rather than on `getMarkdown(editor)`, because the
  // TipTap round-trip renormalizes MDX and so never compares equal, which would
  // otherwise re-set the content on every render and remount every rendered MDX
  // block. Focus is not a reason to skip: dropping the update there is what left
  // the surface stale until the tab was closed and reopened.
  useEffect(() => {
    if (!editor || parseError || appliedBodyRef.current === body) return;
    appliedBodyRef.current = body;
    const { from, to } = editor.state.selection;
    editor.commands.setContent(prepared, { emitUpdate: false });
    if (!editor.isFocused) return;
    const end = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: Math.min(from, end), to: Math.min(to, end) });
  }, [editor, body, parseError, prepared]);

  return { editor, parseError };
}

/** `Cmd/Ctrl+K` opens inline edit on the selection; `Cmd/Ctrl+S` saves. */
function handleEditorKeyDown(
  view: EditorView,
  event: KeyboardEvent,
  callbacks: Pick<ScratchpadEditorOptions, "onInlineEdit" | "onSave">,
): boolean {
  if (!event.metaKey && !event.ctrlKey) return false;
  const key = event.key.toLowerCase();
  if (key === "k") {
    event.preventDefault();
    callbacks.onInlineEdit(inlineEditRequestFor(view));
    return true;
  }
  if (key === "s") {
    event.preventDefault();
    callbacks.onSave();
    return true;
  }
  return false;
}
