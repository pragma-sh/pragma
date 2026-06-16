import { useEffect, useRef, useState } from "react";

import type { Tab } from "@pragma/constants";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { pragmaEditorTheme } from "@/components/editor/codemirror-theme";
import { fileDiff } from "@/lib/tauri";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; oldText: string; newText: string }
  | { kind: "binary" }
  | { kind: "error"; message: string };

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const READ_ONLY = [EditorState.readOnly.of(true), EditorView.editable.of(false), pragmaEditorTheme];

/**
 * Read-only side-by-side diff for `diff` tabs, backed by `@codemirror/merge`.
 * Loads the old/new text via the worktree-scoped `file_diff` command (keyed on
 * the tab id) and recomputes it live each time the tab opens.
 */
export function DiffView({ tab }: { tab: Tab }) {
  const { id: tabId, worktreeId, filePath, diffSide } = tab;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
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

  useEffect(() => {
    if (state.kind !== "ready") {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const view = new MergeView({
      a: { doc: state.oldText, extensions: READ_ONLY },
      b: { doc: state.newText, extensions: READ_ONLY },
      parent: container,
    });
    return () => view.destroy();
  }, [state]);

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
