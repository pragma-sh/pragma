import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

import { CODE_VIEWER_PALETTES, type CodeViewerMode } from "../palette";

/**
 * The editor's base chrome for a mode: surface, text, caret, gutter, selection.
 *
 * Built from the shared palette so the desktop's editor tabs and the mobile
 * viewer cannot drift. A client layers its own extras (inline widgets, find
 * highlights) on top as a second theme.
 */
export function codeEditorTheme(mode: CodeViewerMode, fontFamily: string): Extension {
  const palette = CODE_VIEWER_PALETTES[mode];
  return EditorView.theme(
    {
      "&": {
        backgroundColor: palette.background,
        color: palette.foreground,
        height: "100%",
        fontSize: "13px",
      },
      ".cm-content": { fontFamily, caretColor: palette.caret },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: palette.caret },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: palette.selection,
      },
      ".cm-gutters": { backgroundColor: palette.background, color: palette.gutter, border: "none" },
      ".cm-activeLine": { backgroundColor: palette.activeLine },
      ".cm-activeLineGutter": { backgroundColor: palette.activeLineGutter },
      ".cm-scroller": { fontFamily },
    },
    { dark: mode === "dark" },
  );
}

/**
 * Syntax palettes keyed to Lezer highlight tags: One Dark-inspired for dark
 * (tuned for the `#0b0d10` workspace background), One Light-inspired for light.
 */
const SYNTAX_COLORS: Record<
  CodeViewerMode,
  {
    keyword: string;
    name: string;
    fn: string;
    plain: string;
    type: string;
    number: string;
    string: string;
    regexp: string;
    comment: string;
    invalid: string;
  }
> = {
  dark: {
    keyword: "#c678dd",
    name: "#e06c75",
    fn: "#61afef",
    plain: "#abb2bf",
    type: "#e5c07b",
    number: "#d19a66",
    string: "#98c379",
    regexp: "#56b6c2",
    comment: "#7f848e",
    invalid: "#ff5370",
  },
  light: {
    keyword: "#a626a4",
    name: "#e45649",
    fn: "#4078f2",
    plain: "#383a42",
    type: "#c18401",
    number: "#986801",
    string: "#50a14f",
    regexp: "#0184bc",
    comment: "#a0a1a7",
    invalid: "#ca1243",
  },
};

/** The highlight style for a mode. Pair it with {@link codeSyntaxHighlighting}. */
export function codeHighlightStyle(mode: CodeViewerMode): HighlightStyle {
  const c = SYNTAX_COLORS[mode];
  return HighlightStyle.define([
    { tag: [t.keyword, t.moduleKeyword, t.operatorKeyword], color: c.keyword },
    { tag: [t.controlKeyword, t.definitionKeyword], color: c.keyword },
    { tag: [t.name, t.deleted, t.character, t.propertyName], color: c.name },
    { tag: [t.variableName], color: c.name },
    { tag: [t.function(t.variableName), t.labelName], color: c.fn },
    { tag: [t.definition(t.name), t.separator], color: c.plain },
    { tag: [t.typeName, t.className, t.namespace], color: c.type },
    { tag: [t.number, t.bool, t.null, t.atom], color: c.number },
    { tag: [t.string, t.special(t.string)], color: c.string },
    { tag: [t.regexp, t.escape], color: c.regexp },
    { tag: [t.comment, t.lineComment, t.blockComment], color: c.comment, fontStyle: "italic" },
    { tag: [t.meta, t.documentMeta], color: c.comment },
    { tag: [t.tagName], color: c.name },
    { tag: [t.attributeName], color: c.number },
    { tag: [t.attributeValue], color: c.string },
    { tag: [t.heading], color: c.name, fontWeight: "bold" },
    { tag: [t.link, t.url], color: c.fn, textDecoration: "underline" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "bold" },
    { tag: [t.invalid], color: c.invalid },
  ]);
}

/** Syntax highlighting for a mode. */
export function codeSyntaxHighlighting(mode: CodeViewerMode): Extension {
  return syntaxHighlighting(codeHighlightStyle(mode));
}
