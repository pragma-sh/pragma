import { Chunk } from "@codemirror/merge";
import { type Extension, RangeSetBuilder, Text } from "@codemirror/state";
import { Decoration, EditorView, gutter, GutterMarker } from "@codemirror/view";

import { CODE_VIEWER_PALETTES, type CodeViewerMode } from "../palette";

/** Line separators CodeMirror's `Text` splits on (LF, CRLF, and bare CR). */
const LINE_SPLIT = /\r\n?|\n/;

/** One line of a unified diff: a deletion (`-`) or an insertion (`+`). */
export interface UnifiedDiffLine {
  sign: "-" | "+";
  text: string;
}

/** The lines of `doc` covered by the half-open range `[from, end)`. */
function linesInRange(doc: Text, from: number, end: number): string[] {
  if (end <= from) return [];
  const result: string[] = [];
  let line = doc.lineAt(from);
  while (line.from < end) {
    result.push(line.text);
    if (line.to >= end || line.number >= doc.lines) break;
    line = doc.line(line.number + 1);
  }
  return result;
}

/**
 * The changed lines between two documents, as `-`/`+` lines with no unchanged
 * context. `Chunk.build` aligns changes to whole lines, so an inline edit still
 * yields one deleted line and one inserted line rather than partial fragments.
 */
export function unifiedDiffLines(oldText: string, newText: string): UnifiedDiffLine[] {
  const oldDoc = Text.of(oldText.split(LINE_SPLIT));
  const newDoc = Text.of(newText.split(LINE_SPLIT));
  const lines: UnifiedDiffLine[] = [];
  for (const chunk of Chunk.build(oldDoc, newDoc)) {
    for (const text of linesInRange(oldDoc, chunk.fromA, chunk.endA)) {
      lines.push({ sign: "-", text });
    }
    for (const text of linesInRange(newDoc, chunk.fromB, chunk.endB)) {
      lines.push({ sign: "+", text });
    }
  }
  return lines;
}

/** Gutter marker rendering the `-`/`+` sign beside a changed line. */
class DiffSignMarker extends GutterMarker {
  constructor(readonly sign: "-" | "+") {
    super();
  }

  override eq(other: DiffSignMarker): boolean {
    return other.sign === this.sign;
  }

  override toDOM(): Node {
    const span = document.createElement("span");
    span.className = `cm-diff-sign cm-diff-sign-${this.sign === "-" ? "del" : "add"}`;
    span.textContent = this.sign;
    return span;
  }
}

/** Red/green styling for removed/added lines in a mode. */
function unifiedDiffTheme(mode: CodeViewerMode): Extension {
  const palette = CODE_VIEWER_PALETTES[mode];
  return EditorView.theme(
    {
      ".cm-diff-sign-gutter": { width: "1.6em" },
      ".cm-diff-sign": { display: "block", fontWeight: "700", textAlign: "center" },
      ".cm-diff-sign-del": { color: palette.removed },
      ".cm-diff-sign-add": { color: palette.added },
      ".cm-diff-removed": { backgroundColor: palette.removedBackground },
      ".cm-diff-added": { backgroundColor: palette.addedBackground },
    },
    { dark: mode === "dark" },
  );
}

/** A unified diff as a CodeMirror document plus the extensions that paint it. */
export interface UnifiedDiffDocument {
  doc: Text;
  extensions: Extension[];
}

/**
 * Builds the single-column diff: only the changed lines, each tinted and
 * signed in a gutter, with unchanged context omitted entirely. The caller adds
 * its own base theme, syntax highlighting, and language.
 */
export function unifiedDiffDocument(
  lines: readonly UnifiedDiffLine[],
  mode: CodeViewerMode,
): UnifiedDiffDocument {
  const doc = Text.of(lines.length > 0 ? lines.map((line) => line.text) : [""]);
  const lineDecorations = new RangeSetBuilder<Decoration>();
  const signMarkers = new RangeSetBuilder<GutterMarker>();
  lines.forEach((line, index) => {
    const docLine = doc.line(index + 1);
    lineDecorations.add(
      docLine.from,
      docLine.from,
      Decoration.line({ class: line.sign === "-" ? "cm-diff-removed" : "cm-diff-added" }),
    );
    signMarkers.add(docLine.from, docLine.from, new DiffSignMarker(line.sign));
  });
  const signSet = signMarkers.finish();
  return {
    doc,
    extensions: [
      gutter({
        class: "cm-diff-sign-gutter",
        lineMarker(_view, line) {
          let found: GutterMarker | null = null;
          signSet.between(line.from, line.to, (_from, _to, value) => {
            found ??= value;
          });
          return found;
        },
      }),
      EditorView.decorations.of(lineDecorations.finish()),
      unifiedDiffTheme(mode),
    ],
  };
}
