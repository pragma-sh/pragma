import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { unifiedDiffDocument, unifiedDiffLines } from "@pragma-sh/code-viewer/codemirror";
import { useEffect, useMemo, useRef } from "react";

import { loadLanguageExtension } from "@/components/editor/codemirror-language";
import { pragmaEditorTheme, pragmaSyntaxHighlighting } from "@/components/editor/codemirror-theme";

// The diff model is shared with Pragma Go's viewer; re-exported so callers and
// tests keep importing it from here.
export { unifiedDiffLines } from "@pragma-sh/code-viewer/codemirror";

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

    const diff = unifiedDiffDocument(lines, "dark");
    const language = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: diff.doc,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          ...diff.extensions,
          pragmaSyntaxHighlighting,
          language.of([]),
          pragmaEditorTheme,
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
