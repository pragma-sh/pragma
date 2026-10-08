import { type HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeEditorTheme, codeHighlightStyle } from "@pragma-sh/code-viewer/codemirror";

import { TERMINAL_FONT_FAMILY } from "@/lib/terminal-manager";

/**
 * CodeMirror theme built from the app's own tokens (the `#0b0d10` workspace
 * background, slate text, cyan caret) so editor/diff tabs match the terminal
 * panes. The base chrome is the shared dark palette from
 * `@pragma-sh/code-viewer`, which Pragma Go's viewer paints too; the desktop
 * layers its own find and review-comment styling on top.
 */
export const pragmaEditorTheme: Extension = [
  codeEditorTheme("dark", TERMINAL_FONT_FAMILY),
  EditorView.theme(
    {
      ".cm-scroller": {
        // Make the scroller a container so inline comment widgets can size to the
        // visible viewport width (`100cqw`) instead of the much wider code content.
        containerType: "inline-size",
      },
      // Inline review-comment widgets: pin just past the line-number gutter at the
      // left edge of the scroll viewport and cap their width to the remaining visible
      // area so the comment is always fully readable without horizontal scrolling,
      // even as the code beside it scrolls. The `--cm-gutter-width` offset (published
      // by `gutterWidthSync`) keeps the sticky widget from sliding behind — and being
      // clipped by — the sticky gutter. Reset `white-space`/`overflow-wrap` since the
      // widget inherits the code's `white-space: pre` from `.cm-content`, which would
      // stop long comment text from wrapping and clip it instead.
      ".cm-fuzzy-match": {
        backgroundColor: "rgba(51, 65, 85, 0.6)",
      },
      ".cm-fuzzy-match-active": {
        backgroundColor: "rgba(180, 83, 9, 0.7)",
      },
      ".cm-review-comment": {
        position: "sticky",
        left: "var(--cm-gutter-width, 0px)",
        width: "calc(100cqw - var(--cm-gutter-width, 0px))",
        boxSizing: "border-box",
        whiteSpace: "normal",
        overflowWrap: "anywhere",
      },
    },
    { dark: true },
  ),
];

/**
 * Dark syntax-highlight palette (One Dark-inspired) keyed to Lezer highlight
 * tags, shared with Pragma Go's viewer. Pair it with [`pragmaSyntaxHighlighting`].
 */
export const pragmaHighlightStyle: HighlightStyle = codeHighlightStyle("dark");

/** Syntax-highlighting extension applying [`pragmaHighlightStyle`]. */
export const pragmaSyntaxHighlighting: Extension = syntaxHighlighting(pragmaHighlightStyle);
