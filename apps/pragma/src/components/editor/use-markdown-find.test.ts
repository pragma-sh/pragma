import { act, renderHook } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import { useMarkdownFind } from "./use-markdown-find";

/** Editors created during a test; destroyed in afterEach so ProseMirror's
 * pending selection flush cannot touch `document` after jsdom teardown. */
const liveEditors: Editor[] = [];

function createEditor(content: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit],
    content,
  });
  liveEditors.push(editor);
  return editor;
}

function longDocEditor(needleParagraph: string): Editor {
  const filler = Array.from({ length: 50 }, (_, i) => `<p>filler paragraph number ${i}</p>`).join(
    "",
  );
  return createEditor(`${filler}<p>${needleParagraph}</p>`);
}

afterEach(() => {
  for (const editor of liveEditors.splice(0)) {
    editor.destroy();
  }
});

describe("useMarkdownFind", () => {
  it("finds a match far past the first textblock, not just the one under the cursor", () => {
    const editor = longDocEditor("needle here");
    const { result, unmount } = renderHook(() => useMarkdownFind(editor as never));

    act(() => result.current.setQuery("needle"));

    expect(result.current.matchCount).toBe(1);
    unmount();
  });

  it("replaces the active match in place", () => {
    const editor = longDocEditor("needle here");
    const { result, unmount } = renderHook(() => useMarkdownFind(editor as never));

    act(() => result.current.setQuery("needle"));
    act(() => result.current.setReplaceValue("replaced"));
    act(() => result.current.replaceOne());

    expect(editor.getText()).toContain("replaced here");
    unmount();
  });

  it("findPrevious steps to the prior match instead of re-selecting the current one", () => {
    const editor = createEditor("<p>needle one</p><p>needle two</p><p>needle three</p>");
    const { result, unmount } = renderHook(() => useMarkdownFind(editor as never));

    act(() => result.current.setQuery("needle"));
    expect(result.current.matchCount).toBe(3);
    expect(result.current.currentMatch).toBe(1);

    act(() => result.current.findNext());
    expect(result.current.currentMatch).toBe(2);

    act(() => result.current.findPrevious());
    expect(result.current.currentMatch).toBe(1);
    unmount();
  });
});
