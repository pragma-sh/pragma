import { useEffect, useRef, useState } from "react";

import type { Tab } from "@pragma/constants";
import { MergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { loadLanguageExtension } from "@/components/editor/codemirror-language";
import { pragmaEditorTheme, pragmaSyntaxHighlighting } from "@/components/editor/codemirror-theme";
import { fileDiff } from "@/lib/tauri";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; oldText: string; newText: string }
  | { kind: "binary" }
  | { kind: "error"; message: string };

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Read-only base extensions shared by both diff panes: not editable, the app
 * theme, and the syntax-highlight palette. The per-file language grammar is
 * appended once it resolves so both sides are colorized identically.
 */
const READ_ONLY: Extension[] = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  pragmaEditorTheme,
  pragmaSyntaxHighlighting,
];

/**
 * Read-only side-by-side diff for `diff` tabs, backed by `@codemirror/merge`.
 * Loads the old/new text via the worktree-scoped `file_diff` command (keyed on
 * the tab id) and recomputes it live each time the tab opens. The file's
 * language grammar is resolved lazily so both panes get syntax highlighting.
 */
export function DiffView({ tab }: { tab: Tab }) {
  const { id: tabId, worktreeId, filePath, diffSide } = tab;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [languageExtension, setLanguageExtension] = useState<Extension | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filePath || !diffSide) {
      setState({ kind: "error", message: "This diff tab is missing its file path." });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    // `oldPath` (for renames) isn't persisted on the tab, so committed renames
    // fall back to diffing against the current path — a benign degradation.
    void (async () => {
      try {
        const diff = await fileDiff(worktreeId, filePath, diffSide);
        if (cancelled) {
          return;
        }
        if (diff.binary) {
          setState({ kind: "binary" });
          return;
        }
        setState({ kind: "ready", oldText: diff.oldText, newText: diff.newText });
      } catch (cause) {
        if (!cancelled) {
          setState({ kind: "error", message: messageFor(cause) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabId, worktreeId, filePath, diffSide]);

  // Resolve the language grammar lazily by filename; plain text on no match.
  useEffect(() => {
    if (!filePath) {
      return;
    }
    let cancelled = false;
    setLanguageExtension(null);
    void (async () => {
      const extension = await loadLanguageExtension(filePath);
      if (!cancelled) {
        setLanguageExtension(extension);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabId, filePath]);

  useEffect(() => {
    if (state.kind !== "ready") {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const extensions = languageExtension ? [...READ_ONLY, languageExtension] : READ_ONLY;
    const view = new MergeView({
      a: { doc: state.oldText, extensions },
      b: { doc: state.newText, extensions },
      parent: container,
    });
    return () => view.destroy();
  }, [state, languageExtension]);

  if (state.kind === "binary") {
    return <Placeholder>This file is binary and can't be diffed.</Placeholder>;
  }
  if (state.kind === "error") {
    return <Placeholder>{state.message}</Placeholder>;
  }
  if (state.kind === "loading") {
    return <Placeholder>Loading diff…</Placeholder>;
  }

  return <div className="h-full min-h-0 overflow-auto bg-[#0b0d10]" ref={containerRef} />;
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-[#0b0d10] p-6 text-center text-sm text-slate-400">
      {children}
    </div>
  );
}
