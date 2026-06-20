import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
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
 * Dark syntax-highlight palette tuned for the `#0b0d10` workspace background.
 * Built from the app's own slate/cyan/emerald tokens so highlighted code in the
 * editor and diff tabs reads against the same backdrop as the terminal panes.
 */
export const pragmaHighlightStyle = HighlightStyle.define(
  [
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: "#c792ea" },
    { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "#cbd5e1" },
    { tag: [t.variableName, t.labelName], color: "#82aaff" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#82aaff" },
    { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#e2e8f0" },
    { tag: [t.typeName, t.namespace, t.className], color: "#ffcb6b" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "#f78c6c" },
    { tag: [t.string, t.special(t.string), t.regexp], color: "#c3e88d" },
    { tag: [t.escape], color: "#89ddff" },
    { tag: [t.comment, t.blockComment, t.lineComment], color: "#64748b", fontStyle: "italic" },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "#89ddff" },
    { tag: [t.meta, t.documentMeta, t.processingInstruction], color: "#94a3b8" },
    { tag: [t.tagName], color: "#f07178" },
    { tag: [t.attributeName], color: "#ffcb6b" },
    { tag: [t.attributeValue], color: "#c3e88d" },
    { tag: [t.heading], color: "#82aaff", fontWeight: "bold" },
    { tag: [t.link, t.url], color: "#89ddff", textDecoration: "underline" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "bold" },
    { tag: [t.invalid], color: "#f87171" },
  ],
  { themeType: "dark" },
);

/** Syntax-highlighting extension using {@link pragmaHighlightStyle}. */
export const pragmaSyntaxHighlighting = syntaxHighlighting(pragmaHighlightStyle);

/**
 * Resolves a CodeMirror {@link LanguageDescription} for a file name (by
 * extension), or `null` when no bundled grammar matches. The caller loads it
 * asynchronously and swaps it into the editor via a compartment.
 */
export function detectLanguage(fileName: string | undefined): LanguageDescription | null {
  if (!fileName) {
    return null;
  }
  return LanguageDescription.matchFilename(languages, fileName);
}
