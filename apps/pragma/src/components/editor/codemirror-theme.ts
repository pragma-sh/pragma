import { EditorView } from "@codemirror/view";

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
