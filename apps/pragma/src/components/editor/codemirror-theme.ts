import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

import { TERMINAL_FONT_FAMILY } from "@/lib/terminal-manager";

/**
 * CodeMirror theme built from the app's own tokens (the `#0b0d10` workspace
 * background, slate text, cyan caret) so editor/diff tabs match the terminal
 * panes. Avoids pulling in a third-party theme dependency.
 */
export const pragmaEditorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#0b0d10",
      color: "#cbd5e1",
      height: "100%",
      fontSize: "13px",
    },
    ".cm-content": {
      fontFamily: TERMINAL_FONT_FAMILY,
      caretColor: "#22d3ee",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#22d3ee",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#1e293b",
    },
    ".cm-gutters": {
      backgroundColor: "#0b0d10",
      color: "#475569",
      border: "none",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255,255,255,0.03)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(255,255,255,0.05)",
    },
    ".cm-scroller": {
      fontFamily: TERMINAL_FONT_FAMILY,
    },
  },
  { dark: true },
);

/**
 * Dark syntax-highlight palette (One Dark-inspired) keyed to Lezer highlight
 * tags. Tuned for the `#0b0d10` workspace background so colors stay legible in
 * both `editor` and `diff` tabs; pair it with [`pragmaSyntaxHighlighting`].
 */
export const pragmaHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.operatorKeyword], color: "#c678dd" },
  { tag: [t.controlKeyword, t.definitionKeyword], color: "#c678dd" },
  { tag: [t.name, t.deleted, t.character, t.propertyName], color: "#e06c75" },
  { tag: [t.variableName], color: "#e06c75" },
  { tag: [t.function(t.variableName), t.labelName], color: "#61afef" },
  { tag: [t.definition(t.name), t.separator], color: "#abb2bf" },
  { tag: [t.typeName, t.className, t.namespace], color: "#e5c07b" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#d19a66" },
  { tag: [t.string, t.special(t.string)], color: "#98c379" },
  { tag: [t.regexp, t.escape], color: "#56b6c2" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#7f848e", fontStyle: "italic" },
  { tag: [t.meta, t.documentMeta], color: "#7f848e" },
  { tag: [t.tagName], color: "#e06c75" },
  { tag: [t.attributeName], color: "#d19a66" },
  { tag: [t.attributeValue], color: "#98c379" },
  { tag: [t.heading], color: "#e06c75", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#61afef", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.invalid], color: "#ff5370" },
]);

/** Syntax-highlighting extension applying [`pragmaHighlightStyle`]. */
export const pragmaSyntaxHighlighting = syntaxHighlighting(pragmaHighlightStyle);
