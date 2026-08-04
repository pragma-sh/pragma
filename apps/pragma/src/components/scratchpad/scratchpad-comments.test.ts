import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import {
  parseScratchpadComments,
  ScratchpadCommentPickerExtension,
  setScratchpadPickerActive,
} from "./scratchpad-comments";

describe("parseScratchpadComments", () => {
  it("keeps valid comments and drops malformed entries", () => {
    const comments = parseScratchpadComments(
      JSON.stringify([
        {
          id: "comment-1",
          from: 1,
          to: 5,
          quote: "text",
          text: "Clarify this",
          createdAt: 1,
          resolvedAt: null,
        },
        { id: "broken" },
      ]),
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.text).toBe("Clarify this");
  });

  it("rejects a non-array document", () => {
    expect(() => parseScratchpadComments("{}")).toThrow("must be an array");
  });
});

describe("ScratchpadCommentPickerExtension", () => {
  it("marks the surface while the picker is active", () => {
    const editor = new Editor({
      content: "<p>hello</p>",
      element: document.createElement("div"),
      extensions: [StarterKit, ScratchpadCommentPickerExtension],
    });
    expect(editor.view.dom.classList.contains("scratchpad-picking")).toBe(false);
    setScratchpadPickerActive(editor, true);
    expect(editor.view.dom.classList.contains("scratchpad-picking")).toBe(true);
    setScratchpadPickerActive(editor, false);
    expect(editor.view.dom.classList.contains("scratchpad-picking")).toBe(false);
    editor.destroy();
  });
});
