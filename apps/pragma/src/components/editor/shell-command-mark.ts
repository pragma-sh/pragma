import { type EditorState, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { MarkType, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { InputRule, Mark } from "@tiptap/core";

import { SHELL_COMMAND_PREFIX, matchShellCommand } from "@/lib/prelaunch-commands";

/** Mark name of a {@link ShellCommand} chip. */
export const SHELL_COMMAND_MARK = "shellCommand";

const BACKTICK_RUN = /`+/g;
/** markdown-it instances that already carry the shell-command inline rule. */
const patchedParsers = new WeakSet<MarkdownIt>();

/** The slice of markdown-it's inline state {@link shellCommandRule} reads. */
interface InlineState {
  src: string;
  pos: number;
  push: (type: string, tag: string, nesting: number) => { content: string };
}

/** The slice of a markdown-it instance (bundled by `tiptap-markdown`, untyped here) this mark patches. */
interface MarkdownIt {
  inline: {
    ruler: {
      before: (beforeName: string, ruleName: string, rule: typeof shellCommandRule) => void;
    };
  };
  renderer: { rules: Record<string, (tokens: { content: string }[], index: number) => string> };
  utils: { escapeHtml: (text: string) => string };
}

/**
 * An inline shell command in an agent prompt, drawn as a small `$` chip.
 * Typing `!!` anywhere starts one; **Enter** or **→** at its end leaves it and
 * **Backspace** right after `!!` undoes it. In markdown it is `` !!`command` ``,
 * which `splitPromptCommands` pulls back out at launch.
 */
export const ShellCommand = Mark.create({
  name: SHELL_COMMAND_MARK,
  excludes: "_",
  code: true,

  parseHTML() {
    return [{ tag: "span[data-shell-command]", priority: 60 }];
  },

  renderHTML() {
    return ["span", { "data-shell-command": "", class: "shell-command" }, 0];
  },

  addInputRules() {
    const type = this.type;
    return [
      new InputRule({
        find: new RegExp(`${escapeRegExp(SHELL_COMMAND_PREFIX)}$`),
        handler: ({ state, range }) => {
          // Never inside inline code or an existing command.
          if (
            state.doc
              .resolve(range.from)
              .marks()
              .some((mark) => mark.type.spec.code)
          ) {
            return null;
          }
          state.tr.delete(range.from, range.to).addStoredMark(type.create());
          return undefined;
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { state, view } = this.editor;
        if (!inShellCommand(state, this.type)) return false;
        view.dispatch(exitShellCommand(state, this.type));
        return true;
      },
      // At a chip's end → leaves it without moving (TipTap's `exitable` would
      // insert a space); elsewhere the arrow moves as usual.
      ArrowRight: () => {
        const { state, view } = this.editor;
        if (!inShellCommand(state, this.type)) return false;
        const after = state.selection.$from.nodeAfter;
        if (after && this.type.isInSet(after.marks)) return false;
        view.dispatch(exitShellCommand(state, this.type));
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [pendingChipPlugin(this.type)];
  },

  addStorage() {
    return {
      markdown: {
        serialize: {
          open: (_state: unknown, _mark: unknown, parent: ProseMirrorNode, index: number) =>
            `${SHELL_COMMAND_PREFIX}${backticksFor(parent.child(index), -1)}`,
          close: (_state: unknown, _mark: unknown, parent: ProseMirrorNode, index: number) =>
            backticksFor(parent.child(index - 1), 1),
          escape: false,
          mixable: false,
          // No `expelEnclosingWhitespace`: tiptap-markdown's implementation
          // treats `open` as a fixed string and garbles a function-built one.
        },
        parse: {
          setup(markdownit: MarkdownIt) {
            if (patchedParsers.has(markdownit)) return;
            patchedParsers.add(markdownit);
            markdownit.inline.ruler.before("backticks", "shell_command", shellCommandRule);
            markdownit.renderer.rules.shell_command = (tokens, index) =>
              `<span data-shell-command="">${markdownit.utils.escapeHtml(tokens[index]!.content)}</span>`;
          },
        },
      },
    };
  },
});

/** True when the caret is in a command chip, or typing would start one. */
export function inShellCommand(state: EditorState, type: MarkType): boolean {
  const { selection } = state;
  if (!selection.empty) return false;
  const marks = state.storedMarks ?? selection.$from.marks();
  return marks.some((mark) => mark.type === type);
}

/**
 * Moves the caret to the end of the chip it is in and stops typing into it,
 * so the next character continues the sentence.
 */
function exitShellCommand(state: EditorState, type: MarkType) {
  const { $from } = state.selection;
  let end = $from.pos;
  // Walk forward over the chip's remaining text.
  for (let index = $from.index(); index < $from.parent.childCount; index += 1) {
    const child = $from.parent.child(index);
    if (!type.isInSet(child.marks)) break;
    end = $from.start() + childOffset($from.parent, index) + child.nodeSize;
  }
  const tr = state.tr;
  if (end !== $from.pos) tr.setSelection(TextSelection.create(tr.doc, end));
  const marks = tr.selection.$from.marks().filter((mark) => mark.type !== type);
  return tr.setStoredMarks(marks);
}

function childOffset(parent: ProseMirrorNode, index: number): number {
  let offset = 0;
  for (let at = 0; at < index; at += 1) offset += parent.child(at).nodeSize;
  return offset;
}

/**
 * Draws an empty `$` chip at the caret right after `!!` is typed — the mark
 * only renders once it has text, so without this command mode would be
 * invisible until the first character.
 */
function pendingChipPlugin(type: MarkType): Plugin {
  return new Plugin({
    key: new PluginKey("shellCommandPending"),
    props: {
      decorations(state) {
        const { selection, storedMarks } = state;
        if (!selection.empty || !storedMarks?.some((mark) => mark.type === type)) return null;
        const before = selection.$from.nodeBefore;
        if (before && type.isInSet(before.marks)) return null;
        return DecorationSet.create(state.doc, [
          Decoration.widget(selection.from, pendingChip, {
            side: -1,
            key: "shell-command-pending",
          }),
        ]);
      },
    },
  });
}

/** The empty chip element {@link pendingChipPlugin} draws. */
function pendingChip(): HTMLElement {
  const element = document.createElement("span");
  element.className = "shell-command shell-command-pending";
  element.setAttribute("aria-label", "Shell command");
  return element;
}

/**
 * markdown-it inline rule for `` !!`command` ``: kept verbatim, never parsed as
 * inline markdown, so `*` or `_` in a command survive a round trip.
 */
function shellCommandRule(state: InlineState, silent: boolean): boolean {
  const match = matchShellCommand(state.src, state.pos);
  if (!match) return false;
  if (!silent) state.push("shell_command", "span", 0).content = match.command;
  state.pos = match.end;
  return true;
}

/** A backtick fence longer than any run inside the text (prosemirror-markdown's rule for code). */
function backticksFor(node: ProseMirrorNode, side: number): string {
  let longest = 0;
  if (node.isText) {
    for (const run of node.text!.matchAll(BACKTICK_RUN)) longest = Math.max(longest, run[0].length);
  }
  const fence = "`".repeat(longest + 1);
  if (longest === 0) return fence;
  return side > 0 ? ` ${fence}` : `${fence} `;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
