/** Which color scheme the code document is rendering in. */
export type CodeViewerMode = "light" | "dark";

/** The chrome colors of one mode: surface, text, gutter, selection, diff tints. */
export interface CodeViewerPalette {
  background: string;
  foreground: string;
  caret: string;
  gutter: string;
  selection: string;
  activeLine: string;
  activeLineGutter: string;
  added: string;
  addedBackground: string;
  removed: string;
  removedBackground: string;
}

/**
 * One table for the editor chrome in both modes.
 *
 * Dark is the desktop editor's palette — the `#0b0d10` workspace background,
 * slate text, cyan caret — so a file reads the same on a phone as in a desktop
 * tab. Native clients also read `background` to paint the container a web view
 * mounts in, before the document exists; a mismatch flashes on every push.
 */
export const CODE_VIEWER_PALETTES: Record<CodeViewerMode, CodeViewerPalette> = {
  dark: {
    background: "#0b0d10",
    foreground: "#cbd5e1",
    caret: "#22d3ee",
    gutter: "#475569",
    selection: "#1e293b",
    activeLine: "rgba(255,255,255,0.03)",
    activeLineGutter: "rgba(255,255,255,0.05)",
    added: "#98c379",
    addedBackground: "rgba(152, 195, 121, 0.13)",
    removed: "#e06c75",
    removedBackground: "rgba(224, 108, 117, 0.13)",
  },
  light: {
    background: "#ffffff",
    foreground: "#1f2937",
    caret: "#0891b2",
    gutter: "#94a3b8",
    selection: "#dbeafe",
    activeLine: "rgba(0,0,0,0.03)",
    activeLineGutter: "rgba(0,0,0,0.05)",
    added: "#2f7d32",
    addedBackground: "rgba(46, 160, 67, 0.14)",
    removed: "#c62828",
    removedBackground: "rgba(218, 54, 51, 0.12)",
  },
};

/** The background the document paints in a mode. */
export function codeViewerBackground(mode: CodeViewerMode): string {
  return CODE_VIEWER_PALETTES[mode].background;
}

/** Monospace stack for clients that ship no font of their own. */
export const CODE_VIEWER_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
