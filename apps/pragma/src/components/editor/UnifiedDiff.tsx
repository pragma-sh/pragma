import { Chunk } from "@codemirror/merge";
import { Compartment, EditorState, RangeSetBuilder, Text } from "@codemirror/state";
import { Decoration, EditorView, gutter, GutterMarker } from "@codemirror/view";
import { useEffect, useMemo, useRef } from "react";

import { loadLanguageExtension } from "@/components/editor/codemirror-language";
import { pragmaEditorTheme, pragmaSyntaxHighlighting } from "@/components/editor/codemirror-theme";

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

  eq(other: DiffSignMarker): boolean {
    return other.sign === this.sign;
  }

  toDOM(): Node {
    const span = document.createElement("span");
    span.className = `cm-diff-sign cm-diff-sign-${this.sign === "-" ? "del" : "add"}`;
    span.textContent = this.sign;
    return span;
  }
}

/** Red/green styling for removed/added lines, matching the shared diff palette. */
const unifiedDiffTheme = EditorView.theme(
  {
    ".cm-diff-sign-gutter": { width: "1.6em" },
    ".cm-diff-sign": { display: "block", fontWeight: "700", textAlign: "center" },
    ".cm-diff-sign-del": { color: "#e06c75" },
    ".cm-diff-sign-add": { color: "#98c379" },
    ".cm-diff-removed": { backgroundColor: "rgba(224, 108, 117, 0.13)" },
    ".cm-diff-added": { backgroundColor: "rgba(152, 195, 121, 0.13)" },
  },
  { dark: true },
);

/**
 * A single-column diff showing only the changed lines — deletions in red,
 * insertions in green — with unchanged context omitted entirely, so a reader
 * sees exactly what changed relative to the base document.
 */
export function UnifiedDiff({
  oldText,
  newText,
  fileName,
}: {
  oldText: string;
  newText: string;
  fileName?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => unifiedDiffLines(oldText, newText), [oldText, newText]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || lines.length === 0) return;

    const doc = Text.of(lines.map((line) => line.text));
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

    const language = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          gutter({
            class: "cm-diff-sign-gutter",
            lineMarker(_view, line) {
              let found: GutterMarker | null = null;
              signSet.between(line.from, line.to, (_from, _to, value) => {
                if (!found) found = value;
              });
              return found;
            },
          }),
          EditorView.decorations.of(lineDecorations.finish()),
          pragmaSyntaxHighlighting,
          language.of([]),
          pragmaEditorTheme,
          unifiedDiffTheme,
        ],
      }),
      parent: container,
    });

    let cancelled = false;
    void (async () => {
      const languageExtension = fileName ? await loadLanguageExtension(fileName) : null;
      if (!cancelled && languageExtension) {
        view.dispatch({ effects: language.reconfigure(languageExtension) });
      }
    })();

    return () => {
      cancelled = true;
      view.destroy();
    };
  }, [lines, fileName]);

  if (lines.length === 0) {
    return <p className="p-2 text-xs text-muted-foreground">No changes</p>;
  }

  return <div ref={containerRef} className="h-full min-h-0 overflow-hidden bg-canvas" />;
}
