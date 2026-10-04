import {
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { createPortal } from "react-dom";

import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
import { type Editor, EditorContent, type Extensions, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import { Markdown } from "tiptap-markdown";

import { ShellCommand, inShellCommand } from "@/components/editor/shell-command-mark";
import { getMarkdown } from "@/components/editor/tiptap-markdown";

const lowlight = createLowlight(common);

/** Widest a {@link MarkdownEditor} caret popover is laid out, in pixels. */
const CARET_POPOVER_WIDTH = 352;
/** Gap between the caret's line and the popover below it, in pixels. */
const CARET_POPOVER_GAP = 4;
/** Tallest a caret popover grows (the pickers' `max-h-72`); it flips above the caret when this does not fit below. */
const CARET_POPOVER_MAX_HEIGHT = 288;

/** Imperative control over a mounted {@link MarkdownEditor}. */
export interface MarkdownEditorHandle {
  /** Replaces the document, focuses the editor, and puts the cursor at the end. */
  setMarkdown: (markdown: string) => void;
  /** Replaces the `length` characters just before the caret with plain `text`. */
  replaceBeforeCaret: (length: number, text: string) => void;
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
// fallow-ignore-next-line complexity -- TipTap lifecycle, imperative handle, and caret popover share one editor.
export function MarkdownEditor({
  value,
  onChange,
  onKeyDown,
  placeholder = "Describe your changes…",
  className,
  handleRef,
  caretPopover,
  onCaretTextChange,
  shellCommands,
}: {
  value: string;
  onChange: (markdown: string) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  placeholder?: string;
  className?: string;
  handleRef?: Ref<MarkdownEditorHandle>;
  /** Rendered just below the caret, inside the editor's box (e.g. a `/` command picker). */
  caretPopover?: ReactNode;
  /**
   * Reports the text between the start of the caret's paragraph and the caret
   * on every edit and caret move (empty while a range is selected), e.g. to
   * detect an `@` mention being typed.
   */
  onCaretTextChange?: (textBeforeCaret: string) => void;
  /**
   * Lets `!!` anywhere start an inline shell-command chip (see
   * {@link ShellCommand}). Read once, when the editor mounts.
   */
  shellCommands?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  const onKeyDownRef = useRef(onKeyDown);
  const onCaretTextRef = useRef(onCaretTextChange);

  useEffect(() => {
    onChangeRef.current = onChange;
    onKeyDownRef.current = onKeyDown;
    onCaretTextRef.current = onCaretTextChange;
  }, [onChange, onKeyDown, onCaretTextChange]);

  const editor = useEditor({
    extensions: editorExtensions(placeholder, shellCommands),
    content: value,
    editorProps: {
      attributes: {
        class:
          "tiptap prose prose-invert prose-sm max-w-none min-h-28 px-3 py-2 focus:outline-none",
      },
      handleKeyDown: (_view, event) => {
        onKeyDownRef.current?.(event);
        return event.defaultPrevented;
      },
    },
    onUpdate: ({ editor: instance }) => {
      onChangeRef.current(getMarkdown(instance));
      onCaretTextRef.current?.(textBeforeCaret(instance));
    },
    onSelectionUpdate: ({ editor: instance }) => {
      onCaretTextRef.current?.(textBeforeCaret(instance));
    },
  });

  useImperativeHandle(
    handleRef,
    () => ({
      setMarkdown: (markdown: string) => {
        if (!editor) return;
        // `setContent` does not emit an update; report the new markdown ourselves.
        editor.chain().setContent(markdown).focus("end").run();
        onChangeRef.current(getMarkdown(editor));
      },
      replaceBeforeCaret: (length: number, text: string) => {
        if (!editor) return;
        const to = editor.state.selection.from;
        editor
          .chain()
          .focus()
          // A text node, not a string, so the text is never parsed as HTML
          // (which would also trim a trailing space).
          .insertContentAt({ from: Math.max(0, to - length), to }, { type: "text", text })
          .run();
      },
    }),
    [editor],
  );

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

  const caret = useCaretPosition(editor, boxRef, Boolean(caretPopover));

  return (
    <div
      ref={boxRef}
      className={`relative rounded-md border border-input bg-canvas text-sm text-foreground focus-within:border-primary/60 ${className ?? ""}`}
    >
      <EditorContent editor={editor} />
      {/* Portaled and fixed, so the popover floats over the dialog instead of
          growing its scroll area (which made the modal resize as results changed). */}
      {caretPopover && caret
        ? createPortal(
            <div className="fixed z-[60]" style={caret}>
              {caretPopover}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** The editor's TipTap extensions; `shellCommands` adds the `!!` command chip. */
function editorExtensions(placeholder: string, shellCommands = false): Extensions {
  const extensions: Extensions = [
    StarterKit.configure({ codeBlock: false }),
    CodeBlockLowlight.configure({ lowlight }),
    Link.configure({ openOnClick: false }),
    Placeholder.configure({ placeholder }),
    Markdown,
  ];
  if (shellCommands) extensions.push(ShellCommand);
  return extensions;
}

/**
 * Text from the start of the caret's text block up to a collapsed caret. Empty
 * inside a shell command, whose `@` or `/` is part of the command, not a picker.
 */
function textBeforeCaret(editor: Editor): string {
  const { selection } = editor.state;
  if (!selection.empty) return "";
  const { $from } = selection;
  const shellCommand = editor.schema.marks.shellCommand;
  if (shellCommand && inShellCommand(editor.state, shellCommand)) return "";
  return $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
}

/** Viewport placement of a caret popover: below the caret, or above it when it fits better. */
type CaretPlacement = { left: number; width: number } & ({ top: number } | { bottom: number });

/**
 * Where a caret popover goes in the viewport: just below the caret's line (or
 * just above it when there is more room there), with its left edge clamped so
 * a {@link CARET_POPOVER_WIDTH}-wide popover stays within `box` horizontally.
 * Tracked only while `active`, and re-read on every edit, selection change,
 * scroll, and resize.
 */
function useCaretPosition(
  editor: Editor | null,
  box: RefObject<HTMLDivElement | null>,
  active: boolean,
): CaretPlacement | null {
  const [position, setPosition] = useState<CaretPlacement | null>(null);
  useEffect(() => {
    if (!editor || !active) return;
    const measure = () => {
      const frame = box.current?.getBoundingClientRect();
      if (!frame) return;
      const coords = editor.view.coordsAtPos(editor.state.selection.from);
      const width = Math.min(CARET_POPOVER_WIDTH, frame.width);
      const left = Math.min(Math.max(frame.left, coords.left), frame.right - width);
      const below = window.innerHeight - coords.bottom - CARET_POPOVER_GAP;
      const above = coords.top - CARET_POPOVER_GAP;
      setPosition(
        below < CARET_POPOVER_MAX_HEIGHT && above > below
          ? { left, width, bottom: window.innerHeight - coords.top + CARET_POPOVER_GAP }
          : { left, width, top: coords.bottom + CARET_POPOVER_GAP },
      );
    };
    measure();
    editor.on("update", measure);
    editor.on("selectionUpdate", measure);
    // Capture phase: the dialog card, not the window, is what usually scrolls.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      editor.off("update", measure);
      editor.off("selectionUpdate", measure);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [editor, box, active]);
  return active ? position : null;
}
