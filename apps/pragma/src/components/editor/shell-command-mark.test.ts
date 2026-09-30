import { afterEach, describe, expect, it } from "vitest";

import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

import { SHELL_COMMAND_MARK, ShellCommand } from "@/components/editor/shell-command-mark";
import { getMarkdown } from "@/components/editor/tiptap-markdown";
import { splitPromptCommands } from "@/lib/prelaunch-commands";

const editors: Editor[] = [];

function createEditor(content = ""): Editor {
  const editor = new Editor({ extensions: [StarterKit, Markdown, ShellCommand], content });
  editors.push(editor);
  editor.commands.focus("end");
  return editor;
}

/** Types `text` at the caret the way the view does, so input rules run. */
function type(editor: Editor, text: string): void {
  for (const char of text) {
    const { view } = editor;
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (handler) =>
      handler(view, from, to, char, () => view.state.tr.insertText(char, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
}

/** Sends a key through the editor's keymaps. */
function press(editor: Editor, key: string): void {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  editor.view.someProp("handleKeyDown", (handler) => handler(editor.view, event));
}

/** Text carrying the shell-command mark, in document order. */
function chips(editor: Editor): string[] {
  const found: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === SHELL_COMMAND_MARK)) {
      found.push(node.text!);
    }
  });
  return found;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("ShellCommand", () => {
  it("starts a chip at `!!` mid-sentence, showing an empty `$` chip until it has text", () => {
    const editor = createEditor();
    type(editor, "Fix what !!");
    expect(editor.state.doc.textContent).toBe("Fix what ");
    expect(editor.view.dom.querySelector(".shell-command-pending")).not.toBeNull();

    type(editor, "bun run test");
    expect(chips(editor)).toEqual(["bun run test"]);
    expect(editor.view.dom.querySelector(".shell-command-pending")).toBeNull();
    expect(getMarkdown(editor)).toBe("Fix what !!`bun run test`");
  });

  it("Enter leaves the chip on the same line so the sentence continues", () => {
    const editor = createEditor();
    type(editor, "Fix what !!bun run test");
    press(editor, "Enter");
    type(editor, " reports");
    expect(editor.state.doc.childCount).toBe(1);
    expect(chips(editor)).toEqual(["bun run test"]);
    expect(getMarkdown(editor)).toBe("Fix what !!`bun run test` reports");
  });

  it("→ at the end of a chip leaves it", () => {
    const editor = createEditor();
    type(editor, "run !!ls");
    press(editor, "ArrowRight");
    type(editor, " now");
    expect(chips(editor)).toEqual(["ls"]);
    expect(getMarkdown(editor)).toBe("run !!`ls` now");
  });

  it("Enter from the middle of a chip jumps to its end", () => {
    const editor = createEditor("a !!`ls -la` b");
    // Inside "ls -la": after "a " (2) plus "ls" (2), past the paragraph start (1).
    editor.commands.setTextSelection(5);
    press(editor, "Enter");
    type(editor, "!");
    expect(chips(editor)).toEqual(["ls -la"]);
    expect(editor.state.doc.textContent).toBe("a ls -la! b");
  });

  it("Backspace right after `!!` gives the two characters back", () => {
    const editor = createEditor();
    type(editor, "wow!!");
    press(editor, "Backspace");
    expect(editor.state.doc.textContent).toBe("wow!!");
    type(editor, " yes");
    expect(chips(editor)).toEqual([]);
  });

  it("does not start inside inline code", () => {
    const editor = createEditor("use `ab` ok");
    // Between "a" and "b" inside the code span.
    editor.commands.setTextSelection(6);
    type(editor, "!!");
    expect(editor.state.doc.textContent).toBe("use a!!b ok");
    expect(chips(editor)).toEqual([]);
  });

  it("round-trips through markdown verbatim, backticks and inline markers included", () => {
    for (const markdown of [
      "Fix it with !!`rg '*_foo_*' src` please",
      "run !!`` echo `hi` `` now",
      "two !!`a` and !!`b`",
    ]) {
      const editor = createEditor(markdown);
      expect(getMarkdown(editor)).toBe(markdown);
    }
    const editor = createEditor("Fix it with !!`rg '*_foo_*' src` please");
    expect(chips(editor)).toEqual(["rg '*_foo_*' src"]);
    expect(splitPromptCommands(getMarkdown(editor))).toEqual({
      prompt: "Fix it with `rg '*_foo_*' src` please",
      commands: ["rg '*_foo_*' src"],
    });
  });

  it("leaves plain inline code and bare `!!` as they were", () => {
    const editor = createEditor("wow!! and `code`");
    expect(chips(editor)).toEqual([]);
    expect(getMarkdown(editor)).toBe("wow!! and `code`");
  });
});
